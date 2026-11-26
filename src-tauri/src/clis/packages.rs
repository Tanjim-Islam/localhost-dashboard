use super::{
    discovery::{children, stopped, Endpoint, Environment},
    model::*,
    runner::{run, Plan},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

#[derive(Clone)]
pub(super) struct Package {
    pub identity: Value,
    pub bins: BTreeMap<String, Vec<PathBuf>>,
    pub product: String,
}
impl Package {
    pub(super) fn new(
        source: &str,
        name: &str,
        version: Option<&str>,
        manager_root: &Path,
        install: &Path,
        manager: Option<&Path>,
    ) -> Self {
        let mut identity = json!({
            "source": source,
            "packageId": name,
            "scope": "user",
            "managerRoot": path_string(manager_root),
            "installRoot": path_string(install),
            "ownershipConfidence": "corroborated",
            "uninstallEvidence": "none",
        });
        if let Some(v) = version.filter(|v| v.len() < 128 && !v.chars().any(char::is_control)) {
            identity["packageVersion"] = json!(v)
        }
        if let Some(p) = manager {
            identity["managerExecutablePath"] = json!(path_string(p));
            identity["ownershipConfidence"] = json!("exact");
            identity["uninstallEvidence"] = json!("manager-owned");
        }
        let product = by_package(source, name)
            .map(|d| d.id.clone())
            .unwrap_or_default();
        Self {
            identity,
            bins: BTreeMap::new(),
            product,
        }
    }
    pub(super) fn add(&mut self, n: &str, p: &Path) {
        let name = n.trim_end_matches(".exe").to_ascii_lowercase();
        if p.is_absolute() && command_name(&name) {
            self.bins.entry(name).or_default().push(p.to_owned())
        }
    }
    fn finish(mut self) -> Option<Self> {
        if self.bins.is_empty() {
            return None;
        }
        if self.product.is_empty() {
            self.product = self
                .bins
                .keys()
                .find_map(|n| by_command(n).map(|d| d.id.clone()))
                .unwrap_or_else(|| {
                    id(
                        "discovered-package",
                        json!({
                            "source": self.identity["source"],
                            "packageId": text(&self.identity,"packageId").to_lowercase(),
                        }),
                    )
                });
        }
        Some(self)
    }
}
pub(super) fn child_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative);
    if relative.is_empty()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    let p = root.join(rel);
    if p.exists() && !real(&p).starts_with(real(root)) {
        return None;
    }
    Some(p)
}
// Multiple wheels may advertise the same launcher. The sha256 in a wheel's
// installed RECORD is positive evidence of which distribution wrote the current file.
fn resolve_python_conflicts(packages: &mut [Package]) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut claims = BTreeMap::<PathBuf, Vec<usize>>::new();
    for (index, pkg) in packages
        .iter()
        .enumerate()
        .filter(|(_, p)| p.identity["source"] == "pip")
    {
        for target in pkg.bins.values().flatten() {
            claims.entry(target.clone()).or_default().push(index);
        }
    }
    for (target, owners) in claims.into_iter().filter(|(_, owners)| owners.len() > 1) {
        let Ok(file) = std::fs::File::open(&target) else {
            continue;
        };
        if !file
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= 16 * 1024 * 1024)
        {
            continue;
        }
        let mut hash = Sha256::new();
        if std::io::copy(&mut file.take(16 * 1024 * 1024 + 1), &mut hash).is_err() {
            continue;
        }
        let digest = format!("sha256={}", URL_SAFE_NO_PAD.encode(hash.finalize()));
        let matching: Vec<_> = owners
            .iter()
            .copied()
            .filter(|&idx| {
                let record = Path::new(text(&packages[idx].identity, "installRoot"));
                let Some(site) = record.parent() else {
                    return false;
                };
                read_text(&record.join("RECORD"), 2 * 1024 * 1024).is_some_and(|rows| {
                    rows.lines().any(|line| {
                        let mut cols = line.rsplitn(3, ',');
                        let _size = cols.next();
                        if cols.next() != Some(&digest) {
                            return false;
                        }
                        cols.next().is_some_and(|p| {
                            normal(&real(&site.join(p.trim_matches('"')))) == normal(&real(&target))
                        })
                    })
                })
            })
            .collect();
        if let [winner] = matching.as_slice() {
            for owner in owners.into_iter().filter(|idx| idx != winner) {
                packages[owner].bins.retain(|_, paths| {
                    paths.retain(|path| path != &target);
                    !paths.is_empty()
                });
            }
        }
    }
}
fn node_package(
    source: &str,
    expected: &str,
    root: &Path,
    prefix: &Path,
    manager: Option<&Plan>,
) -> Option<Package> {
    if !valid_pkg("npm", expected) || !root.is_absolute() {
        return None;
    }
    let doc = read_doc(&root.join("package.json"))?;
    if text(&doc, "name") != expected {
        return None;
    }
    let mut pkg = Package::new(
        source,
        expected,
        doc["version"].as_str(),
        prefix,
        root,
        manager.map(|p| p.exe.as_path()),
    );
    if pkg.product.is_empty() {
        pkg.product = by_package("npm", expected)
            .or_else(|| by_command(expected))
            .map(|d| d.id.clone())
            .unwrap_or_else(|| {
                id(
                    "discovered-package",
                    json!({"source":source,"packageId":expected.to_lowercase()}),
                )
            });
    }
    if let Some(m) = manager.and_then(|p| p.args.first()) {
        pkg.identity["managerCommandPath"] = json!(m)
    }
    if source == "unknown" {
        pkg.identity["sourceName"] = json!("Node.js package");
    }
    let bins = if let Some(s) = doc["bin"].as_str() {
        vec![(expected.rsplit('/').next()?, s)]
    } else {
        doc["bin"]
            .as_object()?
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
            .collect()
    };
    for (name, rel) in bins {
        let Some(path) = child_path(root, rel) else {
            continue;
        };
        pkg.add(name, &path);
        if cfg!(windows) && path.extension().is_none() && path.with_extension("exe").is_file() {
            pkg.add(name, &path.with_extension("exe"))
        }
    }
    pkg.finish()
}
fn manager_plan(source: &str, es: &[Endpoint], e: &Endpoint) -> Option<Plan> {
    if !e.data["executable"].as_bool()? && cfg!(windows) {
        return None;
    }
    if ["npm", "pnpm", "yarn-classic"].contains(&source) {
        if normal(&e.canonical).contains("corepack")
            || e.data["shimPackageRoot"].as_str().is_some_and(|p| {
                normal(Path::new(p))
                    .replace('\\', "/")
                    .contains("/corepack")
            })
            || (["cmd", "ps1", "bat", ""].contains(&e.ext.as_str())
                && read_text(&e.path, 65536)
                    .is_some_and(|s| s.to_ascii_lowercase().contains("corepack")))
        {
            return None;
        }
        if cfg!(windows) && e.ext != "exe" {
            let root = e.canonical.parent()?;
            let resolved = e.data["shimTarget"].as_str().map(PathBuf::from);
            if let Some(target) = resolved.as_ref().filter(|p| {
                p.is_file()
                    && p.extension().is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com")
                    })
            }) {
                return Some(Plan::new(target, &[]));
            }
            let bundled = root.join(match source {
                "npm" => "node_modules/npm/bin/npm-cli.js",
                "pnpm" => "node_modules/pnpm/bin/pnpm.cjs",
                _ => "node_modules/yarn/bin/yarn.js",
            });
            let entry = resolved
                .filter(|p| {
                    p.is_file()
                        && p.file_name().is_some_and(|f| match source {
                            "npm" => f == "npm-cli.js",
                            "pnpm" => f == "pnpm.cjs" || f == "pnpm.mjs",
                            _ => f == "yarn.js",
                        })
                })
                .unwrap_or(bundled);
            if !entry.is_file() {
                return None;
            }
            let node = root.join("node.exe");
            let exe = if node.is_file() {
                node
            } else {
                es.iter()
                    .filter(|x| x.name == "node" && x.ext == "exe" && x.order.is_some())
                    .min_by_key(|x| x.order)?
                    .path
                    .clone()
            };
            return Some(Plan {
                exe,
                args: vec![path_string(&entry)],
                env: vec![],
            });
        }
    }
    if cfg!(windows) && !["exe", "com"].contains(&e.ext.as_str()) {
        return None;
    }
    Some(Plan::new(&e.path, &[]))
}
fn node_list(source: &str, raw: &str, m: &Plan, e: &Endpoint) -> Option<Vec<Package>> {
    let mut packages = vec![];
    if source == "yarn-classic" {
        if !raw
            .lines()
            .any(|l| serde_json::from_str::<Value>(l).is_ok_and(|v| v["type"].is_string()))
        {
            return None;
        }
        // Yarn Classic's list does not identify a prefix. Read the declared global prefix independently.
        let root = if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)?
                .join("Yarn/Data/global")
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)?
                .join(".config/yarn/global")
        };
        if let Some(doc) = read_doc(&root.join("package.json")) {
            for name in doc["dependencies"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.keys())
            {
                if let Some(p) = node_package(
                    source,
                    name,
                    &root.join("node_modules").join(name),
                    &root,
                    Some(m),
                ) {
                    packages.push(p)
                }
            }
        }
        return Some(packages);
    }
    let data: Value = serde_json::from_str(raw).ok()?;
    let values = if data.is_array() {
        data.as_array()?.clone()
    } else {
        vec![data]
    };
    for doc in &values {
        let deps = doc["dependencies"].as_object();
        if deps.is_none() && !doc.is_object() {
            return None;
        }
        for (name, val) in deps.into_iter().flatten() {
            if !valid_pkg("npm", name) {
                continue;
            }
            let fallback = text(doc, "path");
            let base = if !fallback.is_empty() {
                PathBuf::from(fallback)
            } else {
                e.path.parent()?.into()
            };
            let p = val["path"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| base.join("node_modules").join(name));
            if !p.is_absolute() {
                continue;
            }
            let modules = p
                .ancestors()
                .find(|p| p.file_name().is_some_and(|s| s == "node_modules"));
            let Some(parent) = modules.and_then(Path::parent) else {
                continue;
            };
            let prefix = if !cfg!(windows) && parent.file_name().is_some_and(|v| v == "lib") {
                parent.parent()?
            } else {
                parent
            };
            if let Some(p) = node_package(source, name, &p, prefix, Some(m)) {
                packages.push(p)
            }
        }
    }
    Some(packages)
}
fn pipx(raw: &str, env: &Environment, m: &Plan) -> Option<Vec<Package>> {
    let doc: Value = serde_json::from_str(raw).ok()?;
    let mut packages = vec![];
    for (name, venv) in doc["venvs"].as_object()? {
        if !valid_pkg("pipx", name) {
            continue;
        }
        let meta = venv
            .pointer("/metadata/main_package")
            .unwrap_or(&venv["main_package"]);
        let mut bins = Vec::new();
        let mut homes = BTreeSet::new();
        for record in list(meta, "app_paths") {
            let Some(path) = record
                .as_str()
                .or_else(|| record["__Path__"].as_str())
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
            else {
                continue;
            };
            let Some(file) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let cmd = file.trim_end_matches(".exe");
            if !strings(&meta["apps"]).any(|app| app.trim_end_matches(".exe") == cmd) {
                continue;
            }
            if path.is_file() {
                let target = real(&path);
                let venv = target
                    .ancestors()
                    .skip(1)
                    .find(|p| p.file_name().is_some_and(|s| s.eq_ignore_ascii_case(name)));
                if let Some(parent) = venv
                    .and_then(Path::parent)
                    .filter(|p| {
                        p.file_name()
                            .is_some_and(|s| s.eq_ignore_ascii_case("venvs"))
                    })
                    .and_then(Path::parent)
                {
                    homes.insert(parent.to_owned());
                }
            }
            bins.push((cmd.to_owned(), path));
        }
        let configured = env.vars.get("PIPX_HOME");
        let home = homes
            .first()
            .cloned()
            .or_else(|| configured.cloned())
            .unwrap_or_else(|| env.home.join(".local/share/pipx"));
        let verified = homes.len() == 1
            && configured.is_none_or(|p| normal(&real(p)) == normal(&home))
            && home.join("venvs").join(name).is_dir();
        let mut p = Package::new(
            "pipx",
            name,
            meta["package_version"].as_str(),
            &home,
            &home.join("venvs").join(name),
            verified.then_some(m.exe.as_path()),
        );
        for (cmd, path) in bins {
            p.add(&cmd, &path);
        }
        if let Some(p) = p.finish() {
            packages.push(p)
        }
    }
    Some(packages)
}
pub(super) fn manager_output(
    source: &str,
    raw: &str,
    env: &Environment,
    plan: &Plan,
    e: &Endpoint,
    es: &[Endpoint],
) -> Option<Vec<Package>> {
    if ["npm", "pnpm", "yarn-classic"].contains(&source) {
        return node_list(source, raw, plan, e);
    }
    if source == "pipx" {
        return pipx(raw, env, plan);
    }
    let mut rows = vec![];
    let prefix = e.path.parent()?.parent()?;
    if source == "homebrew" {
        let d: Value = serde_json::from_str(raw).ok()?;
        d["formulae"].as_array()?;
        for (key, src) in [("formulae", "homebrew-formula"), ("casks", "homebrew-cask")] {
            for item in list(&d, key) {
                let Some(name) = item["full_name"]
                    .as_str()
                    .or(item["name"].as_str())
                    .or(item["token"].as_str())
                else {
                    continue;
                };
                if !valid_pkg("homebrew-formula", name) {
                    continue;
                }
                let short = name.rsplit('/').next()?;
                let version = item["linked_keg"]
                    .as_str()
                    .or(item["version"].as_str())
                    .or_else(|| list(item, "installed").last()?.get("version")?.as_str())
                    .filter(|v| command_name(v));
                let root = prefix
                    .join(if key == "formulae" {
                        "Cellar"
                    } else {
                        "Caskroom"
                    })
                    .join(short)
                    .join(version.unwrap_or(""));
                let mut p = Package::new(src, name, version, prefix, &root, Some(&plan.exe));
                if key == "formulae" {
                    for b in children(&root.join("bin"), 256) {
                        if let Some(n) = b.file_name().and_then(|s| s.to_str()) {
                            p.add(n, &b)
                        }
                    }
                } else {
                    // Only a cask's explicitly declared binary artifacts qualify as commands.
                    for artifact in list(item, "artifacts") {
                        let Some(bin) = artifact["binary"].as_array() else {
                            continue;
                        };
                        let Some(src) = bin.first().and_then(Value::as_str) else {
                            continue;
                        };
                        let target = Path::new(src);
                        let target = if target.is_absolute() {
                            target.to_owned()
                        } else if let Some(target) = child_path(&root, src) {
                            target
                        } else {
                            continue;
                        };
                        let name = bin
                            .get(1)
                            .and_then(|v| v["target"].as_str())
                            .and_then(|v| Path::new(v).file_name()?.to_str())
                            .or_else(|| target.file_name()?.to_str());
                        if let Some(n) = name {
                            p.add(n, &target);
                        }
                    }
                }
                if let Some(p) = p.finish() {
                    rows.push(p)
                }
            }
        }
        return Some(rows);
    }
    let mut labels = vec![];
    if source == "winget" {
        // winget export is unnecessary. Its fixed-width list contains an ID and a version.
        let mut columns = None;
        for l in raw.lines() {
            if let (Some(i), Some(v)) = (l.find("Id"), l.find("Version")) {
                columns = Some((i, v));
                continue;
            }
            if let Some((i, v)) = columns {
                let chars: Vec<_> = l.chars().collect();
                if let (Some(id), Some(ver)) = (chars.get(i..v), chars.get(v..)) {
                    let id: String = id.iter().collect();
                    let ver: String = ver.iter().collect();
                    if let Some(n) = ver.split_whitespace().next() {
                        labels.push((id.trim().to_owned(), n.to_owned()));
                    }
                }
            }
        }
        columns?;
    } else if source == "chocolatey" {
        for l in raw.lines() {
            if let Some((n, v)) = l.trim().split_once('|') {
                labels.push((n.to_owned(), v.to_owned()));
            }
        }
    } else if source == "macports" {
        for l in raw.lines() {
            let mut words = l.split_whitespace();
            if let (Some(n), Some(v)) = (words.next(), words.next()) {
                if let Some(v) = v.strip_prefix('@') {
                    labels.push((n.into(), v.split('+').next()?.into()));
                }
            }
        }
    }
    for (name, version) in labels {
        let Some(def) = by_package(source, &name).or_else(|| by_command(&name)) else {
            continue;
        };
        let mut p = Package::new(source, &name, Some(&version), prefix, prefix, None);
        // Require independent path evidence for these coarse package inventories.
        for ep in es.iter().filter(|ep| def.commands.contains(&ep.name)) {
            let path = normal(&ep.canonical).replace('\\', "/");
            let fits = match source {
                "chocolatey" => path.contains("/chocolatey/"),
                "macports" => path.starts_with("/opt/local/"),
                "winget" => path.contains(&format!("/winget/packages/{}_", name.to_lowercase())),
                _ => false,
            };
            if fits {
                p.add(&ep.name, &ep.path)
            }
        }
        if let Some(p) = p.finish() {
            rows.push(p)
        }
    }
    Some(rows)
}
pub(super) fn collect(
    env: &Environment,
    es: &[Endpoint],
    cancel: &AtomicBool,
    sources: &mut Vec<Value>,
) -> Result<Vec<Package>, String> {
    fn label(source: &str) -> &str {
        match source {
            "npm" => "npm global packages",
            "pnpm" => "pnpm global packages",
            "yarn-classic" => "yarn global packages",
            "pipx" => "pipx applications",
            "chocolatey" => "Chocolatey packages",
            "winget" => "Winget packages",
            "homebrew" => "Homebrew formulas",
            "macports" => "MacPorts packages",
            other => other,
        }
    }
    let mut packages = vec![];
    let mut seen = BTreeSet::new();
    let mut queries = Vec::new();
    for (source_id, cmd, args) in [
        (
            "npm",
            "npm",
            &["ls", "--global", "--depth=0", "--json", "--long"][..],
        ),
        ("pnpm", "pnpm", &["list", "--global", "--depth=0", "--json"]),
        (
            "yarn-classic",
            "yarn",
            &["global", "list", "--json", "--depth=0"],
        ),
        ("pipx", "pipx", &["list", "--output", "json"]),
        ("chocolatey", "choco", &["list", "--limit-output"]),
        ("winget", "winget", &["list", "--disable-interactivity"]),
        ("homebrew", "brew", &["info", "--json=v2", "--installed"]),
        ("macports", "port", &["installed", "-q"]),
    ] {
        let mut found = false;
        for ep in es.iter().filter(|e| e.name == cmd) {
            stopped(cancel)?;
            let Some(plan) = manager_plan(source_id, es, ep) else {
                continue;
            };
            let key = (normal(&real(&plan.exe)), plan.args.clone(), source_id);
            if !seen.insert(key) {
                continue;
            }
            found = true;
            let mut query = Plan::new(&plan.exe, args);
            query.args.splice(0..0, plan.args.clone());
            query.env = vec![
                ("HOMEBREW_NO_AUTO_UPDATE".into(), "1".into()),
                ("HOMEBREW_NO_ANALYTICS".into(), "1".into()),
            ];
            if source_id == "yarn-classic" {
                query.env.extend([
                    ("YARN_IGNORE_PATH".into(), "1".into()),
                    ("SKIP_YARN_COREPACK_CHECK".into(), "1".into()),
                ]);
            }
            queries.push((source_id, ep, plan, query));
        }
        if !found {
            sources.push(source(source_id, label(source_id), "skipped", 0, now()));
        }
    }
    for batch in queries.chunks(4) {
        stopped(cancel)?;
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = batch
                .iter()
                .map(|(source_id, endpoint, manager, query)| {
                    scope.spawn(move || {
                        let started = now();
                        let rows = run(
                            query,
                            &env.neutral,
                            cancel,
                            Duration::from_secs(25),
                            4 * 1024 * 1024,
                        )
                        .ok()
                        .and_then(|out| {
                            manager_output(source_id, &out, env, manager, endpoint, es)
                        });
                        let status = source(
                            &format!("{source_id}|{}", path_string(&endpoint.path)),
                            label(source_id),
                            if rows.is_some() { "success" } else { "failed" },
                            rows.as_ref().map_or(0, Vec::len),
                            started,
                        );
                        (status, rows.unwrap_or_default())
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .map_err(|_| "Package inventory worker failed.".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()
        })?;
        for (result, rows) in results {
            sources.push(result);
            packages.extend(rows);
        }
    }
    passive(env, es, cancel, sources, &mut packages)?;
    resolve_python_conflicts(&mut packages);
    Ok(packages)
}
fn passive(
    env: &Environment,
    es: &[Endpoint],
    cancel: &AtomicBool,
    sources: &mut Vec<Value>,
    packages: &mut Vec<Package>,
) -> Result<(), String> {
    let cargo = env.var("CARGO_HOME", ".cargo");
    let scoop = env.var("SCOOP", "scoop");
    let installed = cargo.join(".crates2.json");
    let mut count = 0;
    let doc = read_doc(&installed);
    if let Some(items) = doc.as_ref().and_then(|v| v["installs"].as_object()) {
        for (spec, val) in items {
            stopped(cancel)?;
            let mut words = spec.split_whitespace();
            let (Some(n), Some(v)) = (words.next(), words.next()) else {
                continue;
            };
            if !valid_pkg("cargo", n) {
                continue;
            }
            let m = cargo
                .join("bin")
                .join(if cfg!(windows) { "cargo.exe" } else { "cargo" });
            let mut p = Package::new(
                "cargo",
                n,
                Some(v),
                &cargo,
                &cargo,
                m.is_file().then_some(m.as_path()),
            );
            for bin in strings(&val["bins"]).filter(|n| command_name(n)) {
                let target = cargo.join("bin").join(bin);
                let target = if cfg!(windows) && target.extension().is_none() {
                    target.with_extension("exe")
                } else {
                    target
                };
                p.add(bin, &target);
            }
            if let Some(p) = p.finish() {
                packages.push(p);
                count += 1
            }
        }
    }
    sources.push(source(
        "cargo",
        "Cargo installed packages",
        if !installed.exists() {
            "skipped"
        } else if doc.as_ref().is_some_and(|v| v["installs"].is_object()) {
            "success"
        } else {
            "failed"
        },
        count,
        now(),
    ));
    if cfg!(windows) {
        let mut count = 0;
        for app in children(&scoop.join("apps"), 2000) {
            stopped(cancel)?;
            let Some(n) = app
                .file_name()
                .and_then(|v| v.to_str())
                .filter(|n| valid_pkg("scoop", n))
            else {
                continue;
            };
            let root = app.join("current");
            let Some(doc) = read_doc(&root.join("manifest.json")) else {
                continue;
            };
            let script = scoop.join("apps/scoop/current/bin/scoop.ps1");
            let mut p = Package::new(
                "scoop",
                n,
                doc["version"].as_str(),
                &scoop,
                &root,
                script.is_file().then_some(script.as_path()),
            );
            // Hooks can also be supplied in architecture-specific sections.
            fn hooks(v: &Value) -> bool {
                match v {
                    Value::Array(a) => a.iter().any(hooks),
                    Value::Object(o) => o.iter().any(|(k, v)| {
                        ["pre_uninstall", "post_uninstall", "uninstaller"].contains(&k.as_str())
                            || hooks(v)
                    }),
                    _ => false,
                }
            }
            p.identity["uninstallEvidence"] = json!(if hooks(&doc) {
                "none"
            } else {
                "simple-manifest"
            });
            let bins = if doc["bin"].is_string() {
                vec![doc["bin"].clone()]
            } else {
                list(&doc, "bin").to_vec()
            };
            for bin in bins {
                let Some(rel) = bin.as_str().or(bin[0].as_str()) else {
                    continue;
                };
                let Some(path) = child_path(&root, rel) else {
                    continue;
                };
                if let Some(n) = bin[1].as_str().or_else(|| path.file_stem()?.to_str()) {
                    p.add(n, &path)
                }
            }
            if let Some(p) = p.finish() {
                packages.push(p);
                count += 1
            }
        }
        sources.push(source("scoop", "Scoop manifests", "success", count, now()));
    }
    let base = env.var("BUN_INSTALL", ".bun").join("install/global");
    let bun_manifest = base.join("package.json");
    let before = packages.len();
    if let Some(doc) = read_doc(&base.join("package.json")) {
        for n in doc["dependencies"]
            .as_object()
            .into_iter()
            .flat_map(|v| v.keys())
        {
            stopped(cancel)?;
            if let Some(p) = node_package("bun", n, &base.join("node_modules").join(n), &base, None)
            {
                packages.push(p)
            }
        }
    }
    let bun_count = packages.len() - before;
    let dirs: BTreeSet<_> = es
        .iter()
        .filter_map(|ep| ep.canonical.parent().map(Path::to_owned))
        .collect();
    let shim_roots: BTreeSet<_> = es
        .iter()
        .filter_map(|e| e.data["shimPackageRoot"].as_str().map(PathBuf::from))
        .collect();
    for root in shim_roots {
        let Some(modules) = root.ancestors().find(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("node_modules"))
        }) else {
            continue;
        };
        let (Some(prefix), Ok(rel)) = (modules.parent(), root.strip_prefix(modules)) else {
            continue;
        };
        let name = path_string(rel).replace('\\', "/");
        if let Some(pkg) = node_package("unknown", &name, &root, prefix, None) {
            packages.push(pkg);
        }
    }
    sources.push(source(
        "bun-passive",
        "Bun global packages",
        if !bun_manifest.exists() {
            "skipped"
        } else if read_doc(&bun_manifest).is_some() {
            "success"
        } else {
            "failed"
        },
        bun_count,
        now(),
    ));
    let mut pip_count = 0;
    let mut pip_partial = false;
    for bin in &dirs {
        stopped(cancel)?;
        let modules = bin.join("node_modules");
        if modules.is_dir() {
            for path in children(&modules, 1024) {
                let mut roots = vec![path.clone()];
                if path
                    .file_name()
                    .is_some_and(|v| v.to_string_lossy().starts_with('@'))
                {
                    roots = children(&path, 500)
                }
                for p in roots {
                    let Ok(n) = p.strip_prefix(&modules) else {
                        continue;
                    };
                    let n = path_string(n).replace('\\', "/");
                    if let Some(p) = node_package("unknown", &n, &p, bin, None) {
                        packages.push(p)
                    }
                }
            }
        }
        if bin
            .file_name()
            .is_some_and(|v| v.eq_ignore_ascii_case("scripts"))
        {
            let Some(base) = bin.parent() else { continue };
            for site in [base.join("Lib/site-packages"), base.join("site-packages")] {
                let candidates = children(&site, 2001);
                if candidates.len() > 2000 {
                    pip_partial = true
                }
                for p in candidates.into_iter().take(2000) {
                    if !p
                        .file_name()
                        .is_some_and(|s| s.to_string_lossy().ends_with(".dist-info"))
                    {
                        continue;
                    }
                    let Some(meta) = read_text(&p.join("METADATA"), 512 * 1024) else {
                        continue;
                    };
                    let Some(name) = meta.lines().find_map(|l| l.strip_prefix("Name: ")) else {
                        continue;
                    };
                    let mut pkg = Package::new(
                        "pip",
                        name,
                        meta.lines().find_map(|l| l.strip_prefix("Version: ")),
                        base,
                        &p,
                        None,
                    );
                    let Some(entries) = read_text(&p.join("entry_points.txt"), 65536) else {
                        continue;
                    };
                    let mut console = false;
                    for l in entries.lines().map(str::trim) {
                        if l.starts_with('[') {
                            console = l == "[console_scripts]";
                            continue;
                        }
                        if console {
                            if let Some((name, _)) = l.split_once('=') {
                                let n = name.trim();
                                if command_name(n) {
                                    pkg.add(n, &bin.join(format!("{n}.exe")))
                                }
                            }
                        }
                    }
                    if let Some(p) = pkg.finish() {
                        pip_count += 1;
                        packages.push(p)
                    }
                }
            }
        }
    }
    sources.push(source(
        "pip",
        "Python command packages",
        if pip_partial { "failed" } else { "success" },
        pip_count,
        now(),
    ));
    let before = packages.len();
    let mut roots = vec![env.var("UV_TOOL_DIR", ".local/share/uv/tools")];
    if let Some(v) = env.vars.get("APPDATA") {
        roots.push(v.join("uv/tools"))
    }
    for root in roots {
        for dir in children(&root, 500) {
            stopped(cancel)?;
            let Some(s) = read_text(&dir.join("uv-receipt.toml"), 128 * 1024) else {
                continue;
            };
            let Ok(doc) = toml::from_str::<toml::Value>(&s) else {
                continue;
            };
            let tool = doc.get("tool").unwrap_or(&doc);
            let Some(name) = tool
                .get("requirements")
                .and_then(|v| v.as_array())
                .and_then(|v| v.first())
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            let mut pkg = Package::new("uv", name, None, &root, &dir, None);
            for e in tool
                .get("entrypoints")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if let (Some(n), Some(p)) = (
                    e.get("name").and_then(|v| v.as_str()),
                    e.get("install-path").and_then(|v| v.as_str()),
                ) {
                    let path = Path::new(p);
                    if path.file_name().is_some_and(|s| s.eq_ignore_ascii_case(n)) {
                        pkg.add(n, path)
                    }
                }
            }
            if let Some(p) = pkg.finish() {
                packages.push(p)
            }
        }
    }
    sources.push(source(
        "uv",
        "uv tool receipts",
        "success",
        packages.len() - before,
        now(),
    ));
    Ok(())
}
pub(super) fn probe_plan(ep: &Endpoint, es: &[Endpoint], args: &[String]) -> Option<Plan> {
    if !ep.data["executable"].as_bool()? || ep.data["kind"] == "app-alias" {
        return None;
    }
    let mut p = if ["npm", "pnpm", "yarn"].contains(&ep.name.as_str()) {
        manager_plan(
            if ep.name == "yarn" {
                "yarn-classic"
            } else {
                &ep.name
            },
            es,
            ep,
        )?
    } else {
        if cfg!(windows) && !["exe", "com"].contains(&ep.ext.as_str()) {
            let target = Path::new(ep.data["shimTarget"].as_str()?);
            if !target
                .extension()
                .is_some_and(|v| v.eq_ignore_ascii_case("exe") || v.eq_ignore_ascii_case("com"))
            {
                return None;
            }
            Plan::new(target, &[])
        } else {
            Plan::new(&ep.path, &[])
        }
    };
    p.args.extend_from_slice(args);
    Some(p)
}
