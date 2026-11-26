use super::{
    discovery::{self, Endpoint, Environment},
    model::*,
    packages::{self, Package},
    runner::run,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::{atomic::AtomicBool, LazyLock},
    time::Duration,
};

pub(super) type Progress<'a> = dyn Fn(&str, &str, usize, usize) + Sync + 'a;
#[derive(Default)]
struct Group {
    product: String,
    identity: Value,
    indices: Vec<usize>,
    standalone: String,
    provided: BTreeSet<String>,
}
fn owner_key(p: &Package) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        p.product,
        text(&p.identity, "source"),
        text(&p.identity, "packageId"),
        text(&p.identity, "managerRoot"),
        text(&p.identity, "installRoot")
    )
}
fn group_key(ep: &Endpoint, prod: &str) -> String {
    format!(
        "{prod}|{}",
        normal(if cfg!(windows) {
            ep.canonical.parent().unwrap_or(&ep.canonical)
        } else {
            &ep.canonical
        })
    )
}
fn installation_id(g: &Group) -> String {
    let ident = &g.identity;
    id(
        "cli",
        json!({
            "platform": platform(),
            "productId": g.product,
            "source": ident["source"].as_str().unwrap_or("standalone"),
            "packageId": text(ident,"packageId").to_lowercase(),
            "scope": ident["scope"].as_str().unwrap_or("unknown"),
            "managerRoot": normal(Path::new(text(ident,"managerRoot"))),
            "installationRoot": normal(Path::new(text(ident,"installRoot"))),
            "canonicalPath": g.standalone,
        }),
    )
}
fn origin(g: &Group, endpoints: &[Endpoint], env: &Environment) -> &'static str {
    if definitions().any(|d| d.id == g.product && d.application_cli) {
        return "application-embedded";
    }
    let paths: Vec<_> = g
        .indices
        .iter()
        .map(|&i| normal(&endpoints[i].canonical).replace('\\', "/"))
        .collect();
    if paths.iter().any(|s| {
        s.contains("/.codex/tmp/")
            || s.contains("/openai/codex/bin/")
            || ((s.contains("/.cache/codex-runtimes/") || s.contains("/openai/codex/runtimes/"))
                && s.contains("/dependencies/"))
    }) {
        return "application-embedded";
    }
    if !["docker", "docker-compose"].contains(&g.product.as_str())
        && paths
            .iter()
            .any(|s| s.contains("/docker/docker/resources/bin/"))
    {
        return "sdk-bundled";
    }
    if g.indices
        .iter()
        .any(|&i| endpoints[i].data["bundledWith"] == "strawberry-perl")
    {
        return "sdk-bundled";
    }
    if !g.identity.is_null() && !["registry", "unknown"].contains(&text(&g.identity, "source")) {
        return "package-manager";
    }
    if paths.iter().any(|p| {
        p.contains("/program files/")
            || p.contains("/programdata/")
            || p.starts_with("/usr/bin/")
            || p.starts_with("/usr/sbin/")
    }) {
        return "system";
    }
    if g.indices
        .iter()
        .any(|&i| endpoints[i].path.starts_with(&env.home))
    {
        "user"
    } else {
        "unknown"
    }
}
fn group(es: &mut Vec<Endpoint>, packages: Vec<Package>, env: &Environment) -> Vec<Group> {
    let mut paths: HashMap<_, _> = es
        .iter()
        .enumerate()
        .map(|(i, e)| ((e.name.clone(), normal(&e.canonical)), i))
        .collect();
    let mut names: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, e) in es.iter().enumerate() {
        names.entry(e.name.clone()).or_default().push(i);
    }
    let mut owners: BTreeMap<usize, (usize, BTreeSet<String>)> = BTreeMap::new();
    let mut groups = BTreeMap::<String, Group>::new();
    for p in packages {
        let key = owner_key(&p);
        let source = text(&p.identity, "source");
        let priority = match source {
            "npm" | "pipx" | "cargo" | "homebrew-formula" | "scoop" => 3,
            "registry" => 1,
            _ => 2,
        };
        let prefix = real(Path::new(text(&p.identity, "managerRoot")));
        for (n, targets) in &p.bins {
            for target in targets {
                if !target.is_file() {
                    continue;
                }
                let target = real(target);
                let target_key = (n.clone(), normal(&target));
                let idx = if let Some(i) = paths.get(&target_key) {
                    *i
                } else {
                    if es.len() >= 12000 {
                        continue;
                    }
                    let Some(mut ep) = discovery::inspect(&target, n, None, env, true) else {
                        continue;
                    };
                    // Raw package entrypoints supplement the launcher and never gain PATH precedence.
                    if cfg!(windows) && !["exe", "com"].contains(&ep.ext.as_str()) {
                        ep.data["executable"] = json!(false);
                    }
                    let idx = es.len();
                    es.push(ep);
                    paths.insert(target_key, idx);
                    idx
                };
                let mut matches = vec![idx];
                for &ei in names.get(n).into_iter().flatten() {
                    let e = &es[ei];
                    if e.canonical == target
                        || e.data["shimTarget"]
                            .as_str()
                            .is_some_and(|s| normal(&real(Path::new(s))) == normal(&target))
                    {
                        matches.push(ei);
                        continue;
                    }
                    if ["npm", "pnpm", "bun", "yarn-classic", "unknown"].contains(&source)
                        && ["cmd", "bat", "ps1", ""].contains(&e.ext.as_str())
                        && e.canonical
                            .parent()
                            .is_some_and(|dir| dir == prefix || dir == prefix.join("bin"))
                    {
                        let Some(dir) = e.canonical.parent() else {
                            continue;
                        };
                        let Ok(rel) = target.strip_prefix(dir) else {
                            continue;
                        };
                        let expected = normal(rel).replace('\\', "/");
                        if read_text(&e.path, 65536).is_some_and(|s| {
                            s.replace('\\', "/")
                                .to_lowercase()
                                .contains(&expected.to_lowercase())
                        }) {
                            matches.push(ei);
                        }
                    }
                    if source == "scoop"
                        && e.canonical
                            .parent()
                            .is_some_and(|d| d == prefix.join("shims"))
                    {
                        if read_text(&e.path.with_extension("shim"), 8192).is_some_and(|s| {
                            s.lines().any(|line| {
                                line.trim().strip_prefix("path = ").is_some_and(|v| {
                                    normal(&real(Path::new(v.trim_matches('"')))) == normal(&target)
                                })
                            })
                        }) {
                            matches.push(ei);
                        }
                    }
                }
                for i in matches {
                    let owned = owners.entry(i).or_default();
                    if priority > owned.0 {
                        owned.1.clear();
                        owned.0 = priority
                    }
                    if priority == owned.0 {
                        owned.1.insert(key.clone());
                    }
                }
            }
        }
        let declared = p.bins.keys().cloned().collect::<Vec<_>>();
        groups
            .entry(key)
            .or_insert_with(|| Group {
                product: p.product,
                identity: p.identity,
                ..Group::default()
            })
            .provided
            .extend(declared);
    }
    for (i, e) in es.iter().enumerate() {
        if let Some((_, keys)) = owners.get(&i) {
            if keys.len() == 1 {
                groups
                    .get_mut(keys.first().unwrap())
                    .unwrap()
                    .indices
                    .push(i);
                continue;
            }
        }
        if !e.data["executable"].as_bool().unwrap_or(false) && !e.data["kind"].eq("symlink") {
            continue;
        }
        let product = by_command(&e.name)
            .map(|d| d.id.clone())
            .unwrap_or_else(|| format!("discovered-command:{}", e.name));
        let key = group_key(e, &product);
        groups
            .entry(key.clone())
            .or_insert_with(|| Group {
                product,
                standalone: key,
                ..Group::default()
            })
            .indices
            .push(i);
    }
    groups
        .into_values()
        .filter(|g| !g.indices.is_empty())
        .take(10000)
        .collect()
}
pub(super) fn capability(identity: &Value, prod: &str, origin: &str, commands: &[String]) -> Value {
    let source = identity["source"].as_str().unwrap_or("standalone");
    let (status, code, reason) = if ["sdk-bundled", "application-embedded"].contains(&origin) {
        (
            "blocked",
            "embedded-tool",
            "Bundled tools are managed by their owning application or SDK.",
        )
    } else if definitions().any(|d| {
        d.foundational && (d.id == prod || commands.iter().any(|c| d.commands.contains(c)))
    }) {
        (
            "manual-only",
            "foundational-tool",
            "Foundational runtimes and package managers are manual-only.",
        )
    } else if identity.is_null() {
        (
            "blocked",
            "standalone-binary",
            "No package manager was identified for this executable.",
        )
    } else if identity["ownershipConfidence"] != "exact" {
        (
            "blocked",
            "identity-uncertain",
            "Current package ownership is not exact.",
        )
    } else if ["npm", "pipx"].contains(&source) {
        (
            "supported",
            "exact-manager-owned",
            "Exact package ownership is available.",
        )
    } else if ["cargo", "homebrew-formula"].contains(&source)
        || (source == "scoop" && identity["uninstallEvidence"] == "simple-manifest")
    {
        (
            "requires-warning",
            "multiple-commands",
            "Every command provided by this package will be removed.",
        )
    } else {
        (
            "manual-only",
            "manager-policy",
            "This package source is inventory-only.",
        )
    };
    json!({
        "source": source,
        "packageId": identity["packageId"],
        "providedCommands": commands,
        "requiresElevation": false,
        "status": status,
        "reasonCode": code,
        "reason": reason,
        "warnings": if status=="requires-warning"{vec![reason]}else{vec![]},
    })
}
fn probe(
    ep: &Endpoint,
    es: &[Endpoint],
    def: &Definition,
    env: &Environment,
    cancel: &AtomicBool,
) -> Option<String> {
    let probe = def.version_probe.as_ref()?;
    if !probe.platforms.is_empty() && !probe.platforms.iter().any(|s| s == platform()) {
        return None;
    }
    if ep.name != probe.command_name && !def.commands.contains(&ep.name) {
        return None;
    }
    let plan = packages::probe_plan(ep, es, &probe.args)?;
    let out = run(
        &plan,
        &env.neutral,
        cancel,
        Duration::from_millis(probe.timeout_ms.clamp(100, 10000)),
        32768,
    )
    .ok()?;
    static VERSION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b[0-9]+\.[0-9]+(?:\.[0-9]+)*(?:[-+][0-9a-z.-]+)?").unwrap()
    });
    VERSION
        .find(&out)
        .map(|m| m.as_str().chars().take(128).collect())
}
fn is_embedded(v: &Value) -> bool {
    matches!(text(v, "origin"), "sdk-bundled" | "application-embedded")
}
pub(super) fn products(snapshot: &mut Value) {
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for i in list(snapshot, "installations") {
        groups.entry(text(i, "productId")).or_default().push(i);
    }
    let mut commands: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for c in list(snapshot, "commands") {
        commands
            .entry(text(c, "productId"))
            .or_default()
            .insert(text(c, "name"));
    }
    let mut products = vec![];
    for (prod, installs) in groups.into_iter().take(5000) {
        let def = definitions().find(|d| d.id == prod);
        let ids = |items: &[&Value]| items.iter().map(|i| i["id"].clone()).collect::<Vec<_>>();
        let candidates: Vec<_> = installs
            .iter()
            .copied()
            .filter(|i| i["discoveryKind"] == "candidate" && i["presence"] == "present")
            .collect();
        let embedded: Vec<_> = installs
            .iter()
            .copied()
            .filter(|i| is_embedded(i) && i["presence"] == "present")
            .collect();
        let current: Vec<_> = installs
            .iter()
            .copied()
            .filter(|i| {
                i["presence"] == "present" && !is_embedded(i) && i["discoveryKind"] != "candidate"
            })
            .collect();
        let names = commands.get(prod).cloned().unwrap_or_default();
        let alias = installs
            .iter()
            .find_map(|i| i["packageIdentity"]["packageId"].as_str())
            .unwrap_or_else(|| names.first().copied().unwrap_or(prod));
        let issues: BTreeSet<_> = current
            .iter()
            .flat_map(|i| strings(&i["issueCodes"]))
            .collect();
        let health = if current.is_empty() {
            "unknown"
        } else if current.iter().all(|i| i["health"] == "broken") {
            "broken"
        } else if !issues.is_empty() {
            "warning"
        } else {
            "healthy"
        };
        let verified = current
            .iter()
            .any(|i| i["verificationStatus"] == "verified");
        products.push(json!({
            "id": prod,
            "displayName": def.map_or(alias,|d|&d.display_name),
            "category": def.map_or("developer-tool",|d|&d.category),
            "aliases": def.map(|d|&d.aliases).cloned().unwrap_or_default(),
            "commandNames": names,
            "supportedPlatforms": def.filter(|d|!d.platforms.is_empty()).map(|d|d.platforms.clone()).unwrap_or_else(||vec![platform().into()]),
            "discoveryConfidence": if def.is_some(){"catalogued"}else if installs.iter().any(|i|i["packageIdentity"].is_object()){"package-owned"}else{"executable"},
            "installationIds": ids(&installs),
            "currentInstallationIds": ids(&current),
            "candidateInstallationIds": ids(&candidates),
            "embeddedInstallationIds": ids(&embedded),
            "removedInstallationIds": [],
            "health": health,
            "verificationStatus": if verified{"verified"}else{"partially-verified"},
            "issueCodes": issues,
        }));
    }
    snapshot["products"] = json!(products)
}
pub(super) fn scan(
    env: &Environment,
    old: &Value,
    cancel: &AtomicBool,
    force: Option<&str>,
    progress: &Progress,
) -> Result<Value, String> {
    progress("enumerating-path", "Enumerating PATH directories", 0, 0);
    let (mut es, mut sources) = discovery::enumerate(env, cancel)?;
    progress("reading-package-sources", "Reading package sources", 0, 0);
    let mut packages = packages::collect(env, &es, cancel, &mut sources)?;
    #[cfg(windows)]
    if let Some(reg) = &env.registry {
        sources.push(reg.source.clone());
        packages.extend(reg.attribute(env, &mut es));
    }
    progress("matching-installations", "Matching installations", 0, 0);
    let groups = group(&mut es, packages, env);
    let mut commands = vec![];
    let mut installs = vec![];
    let mut endpoints = vec![];
    let mut active = BTreeMap::<String, (usize, usize, String)>::new();
    let mut path_owners = BTreeMap::<String, usize>::new();
    for g in &groups {
        if ["application-embedded", "sdk-bundled"].contains(&origin(g, &es, env)) {
            continue;
        }
        let mut provided_on_path = BTreeSet::new();
        for &i in &g.indices {
            let e = &es[i];
            if let Some((a, b)) = e.order.filter(|_| e.data["targetExists"] == true) {
                provided_on_path.insert(&e.name);
                let item = (a, b, text(&e.data, "id").to_owned());
                active
                    .entry(e.name.clone())
                    .and_modify(|old| *old = old.clone().min(item.clone()))
                    .or_insert(item);
            }
        }
        for name in provided_on_path {
            *path_owners.entry(name.clone()).or_default() += 1;
        }
    }
    let previous_by_id = list(old, "installations")
        .iter()
        .map(|v| (text(v, "id"), v))
        .collect::<HashMap<_, _>>();
    let mut previous_by_path: HashMap<String, Vec<&Value>> = HashMap::new();
    let old_ep: HashMap<_, _> = list(old, "endpoints")
        .iter()
        .map(|e| (text(e, "id"), e))
        .collect();
    for v in list(old, "installations") {
        for k in strings(&v["endpointIds"]) {
            if let Some(ep) = old_ep.get(k) {
                previous_by_path
                    .entry(normal(Path::new(text(ep, "path"))))
                    .or_default()
                    .push(v);
            }
        }
    }
    let timestamp = now();
    let total = groups.len();
    let mut completed = 0;
    for g in groups {
        discovery::stopped(cancel)?;
        let idv = installation_id(&g);
        let def = definitions().find(|d| d.id == g.product);
        let org = origin(&g, &es, env);
        let mut members: Vec<_> = g.indices.iter().map(|&i| &es[i]).collect();
        members.sort_by_key(|e| (e.order.unwrap_or((usize::MAX, usize::MAX)), normal(&e.path)));
        let mut fps: Vec<_> = members
            .iter()
            .map(|e| text(&e.data, "fingerprint"))
            .collect();
        fps.sort();
        let fp = id(
            "install-fp",
            json!({"platform":platform(),"owner":g.identity,"endpoints":fps}),
        );
        let previous = previous_by_id.get(idv.as_str()).copied().or_else(|| {
            members.iter().find_map(|e| {
                previous_by_path
                    .get(&normal(&e.path))?
                    .iter()
                    .copied()
                    .find(|v| v["productId"] == g.product)
            })
        });
        let included = previous.is_some_and(|v| v["includedByUser"] == true);
        let kind = if def.is_some() {
            "catalogue"
        } else if g.identity.is_object()
            && !["winget", "registry", "chocolatey", "homebrew-cask"]
                .contains(&text(&g.identity, "source"))
        {
            "package-command"
        } else if included {
            "user"
        } else {
            "candidate"
        };
        let names: BTreeSet<_> = members.iter().map(|e| e.name.clone()).collect();
        let mut cids = vec![];
        let mut issues = BTreeSet::<&str>::new();
        for name in &names {
            let local: Vec<_> = members
                .iter()
                .copied()
                .filter(|e| &e.name == name)
                .collect();
            let chosen = local
                .iter()
                .find(|e| active.get(name).is_some_and(|a| a.2 == text(&e.data, "id")));
            let role = if chosen.is_some() {
                "active"
            } else if local.iter().any(|e| e.order.is_some())
                && !["application-embedded", "sdk-bundled"].contains(&org)
            {
                "shadowed"
            } else {
                "not-on-path"
            };
            if role == "shadowed" {
                issues.insert("shadowed");
            }
            if role != "not-on-path" && path_owners.get(name).is_some_and(|count| *count > 1) {
                issues.insert("path-conflict");
            }
            let cid = id("command", json!({"installationId":idv,"name":name}));
            cids.push(cid.clone());
            let mut c = json!({
                "id": cid,
                "productId": g.product,
                "installationId": idv,
                "name": name,
                "endpointIds": local.iter().map(|e|&e.data["id"]).collect::<Vec<_>>(),
                "pathRole": role,
            });
            if let Some(ep) = chosen {
                c["activeEndpointId"] = ep.data["id"].clone();
            }
            commands.push(c);
        }
        let mut version = g.identity["packageVersion"].as_str().map(str::to_owned);
        let mut vs = if version.is_some() {
            "package-metadata"
        } else {
            "unknown"
        };
        let mut verification = Value::Null;
        if version.is_none() {
            if let Some(v) = members.iter().find_map(|e| e.data["fileVersion"].as_str()) {
                version = Some(v.into());
                vs = "executable-metadata";
            }
        }
        if g.product == "gcloud" {
            if let Some(v) = members.iter().find_map(|e| {
                let bin = e.path.parent()?;
                if !bin.file_name()?.eq_ignore_ascii_case("bin") {
                    return None;
                }
                let s = read_text(&bin.parent()?.join("VERSION"), 512)?;
                let s = s.trim();
                (!s.is_empty()
                    && s.split('.')
                        .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
                .then(|| s.to_owned())
            }) {
                version = Some(v);
                vs = "package-metadata";
            }
        }
        let mut health = if members.iter().all(|e| e.data["targetExists"] == false) {
            issues.insert("missing-target");
            "broken"
        } else {
            "healthy"
        };
        let unchanged = previous.filter(|p| p["fingerprint"] == fp);
        if let Some(p) = unchanged {
            if p["versionSource"] == "version-probe" {
                version = p["version"].as_str().map(str::to_owned);
                vs = "version-probe";
            }
            verification = p["commandVerification"].clone();
            if p["health"] == "incomplete" {
                health = "incomplete";
                issues.insert("incomplete-installation");
            }
        }
        if let Some(d) = def.filter(|_| org != "application-embedded" && org != "sdk-bundled") {
            if force == Some(idv.as_str())
                || d.always_probe_version
                || (unchanged.is_none() && (d.prefer_version_probe || version.is_none()))
            {
                for e in &members {
                    if let Some(v) = probe(e, &es, d, env, cancel) {
                        version = Some(v);
                        vs = "version-probe";
                        verification = json!({
                            "endpointId": e.data["id"],
                            "endpointFingerprint": e.data["fingerprint"],
                            "checkedAt": timestamp,
                        });
                        break;
                    }
                }
                if let Some(pr) = &d.incomplete_probe {
                    if let Some(plan) = members
                        .iter()
                        .find(|e| e.name == pr.command_name)
                        .and_then(|e| packages::probe_plan(e, &es, &pr.args))
                    {
                        if run(&plan, &env.neutral, cancel, Duration::from_secs(3), 65536)
                            .is_ok_and(|s| s.trim().is_empty())
                        {
                            health = "incomplete";
                            issues.insert("incomplete-installation");
                        }
                    }
                }
            }
        }
        let earliest = previous
            .and_then(|p| p["firstSeenAt"].as_u64())
            .unwrap_or(timestamp);
        let cap = capability(
            &g.identity,
            &g.product,
            org,
            &names.union(&g.provided).cloned().collect::<Vec<_>>(),
        );
        let mut item = json!({
            "id": idv,
            "productId": g.product,
            "platform": platform(),
            "architecture": arch(),
            "scope": g.identity["scope"].as_str().unwrap_or("unknown"),
            "origin": org,
            "discoveryKind": kind,
            "includedByUser": included,
            "versionSource": vs,
            "verificationStatus": if verification.is_object(){"verified"}else if g.identity.is_null(){"ownership-unknown"}else{"partially-verified"},
            "endpointIds": members.iter().map(|e|&e.data["id"]).collect::<Vec<_>>(),
            "commandIds": cids,
            "fingerprint": fp,
            "presence": "present",
            "health": health,
            "issueCodes": issues,
            "firstSeenAt": earliest,
            "lastSeenAt": timestamp,
            "lastVerifiedAt": timestamp,
            "uninstallCapability": cap,
        });
        if let Some(v) = version {
            item["version"] = json!(v);
        }
        if verification.is_object() {
            item["commandVerification"] = verification;
            item["lastSuccessfulVerificationAt"] = json!(timestamp);
        }
        if g.identity.is_object() {
            item["packageIdentity"] = g.identity;
        }
        installs.push(item);
        endpoints.extend(members.iter().map(|e| e.data.clone()));
        completed += 1;
        if completed == 1 || completed % 30 == 0 {
            progress("checking-versions", "Checking versions", completed, total)
        }
    }
    let mut versions = HashMap::new();
    for i in &installs {
        if !is_embedded(i) && i["version"].is_string() {
            let key = (
                text(i, "productId").to_owned(),
                text(i, "version").to_owned(),
            );
            *versions.entry(key).or_insert(0) += 1;
        }
    }
    for i in &mut installs {
        if !is_embedded(i)
            && versions
                .get(&(
                    text(i, "productId").to_owned(),
                    text(i, "version").to_owned(),
                ))
                .is_some_and(|n| *n > 1)
        {
            if let Some(a) = i["issueCodes"].as_array_mut() {
                a.push(json!("duplicate-version"));
            }
        }
    }
    let partial = sources.iter().any(|s| s["status"] == "failed");
    let mut snap = json!({
        "schemaVersion": 2,
        "revision": uuid::Uuid::new_v4().to_string(),
        "platform": platform(),
        "architecture": arch(),
        "generatedAt": now(),
        "cached": false,
        "completeness": if partial{"partial"}else{"complete"},
        "products": [],
        "commands": commands,
        "endpoints": endpoints,
        "installations": installs,
        "sourceResults": sources,
    });
    if partial {
        let confirmed: BTreeSet<_> = list(&snap, "installations")
            .iter()
            .map(|v| text(v, "id").to_owned())
            .collect();
        let failed: BTreeSet<_> = list(&snap, "sourceResults")
            .iter()
            .filter(|v| v["status"] == "failed")
            .map(|v| {
                text(v, "sourceId")
                    .split('|')
                    .next()
                    .unwrap_or("")
                    .to_owned()
            })
            .collect();
        for i in list(old, "installations").iter().filter(|i| {
            !confirmed.contains(text(i, "id"))
                && failed.contains(text(&i["packageIdentity"], "source"))
        }) {
            if snap["installations"].as_array().unwrap().len() >= 10000 {
                break;
            }
            let mut stale = i.clone();
            stale["presence"] = json!("unknown");
            stale["health"] = json!("unknown");
            stale["verificationStatus"] = json!("cached");
            stale["issueCodes"] = json!(["package-source-unavailable"]);
            stale["uninstallCapability"]["status"] = json!("blocked");
            stale["endpointIds"] = json!([]);
            stale["commandIds"] = json!([]);
            snap["installations"].as_array_mut().unwrap().push(stale);
        }
    } else {
        snap["lastSuccessfulScanAt"] = json!(now())
    }
    progress("finalizing", "Finalizing inventory", total, total);
    products(&mut snap);
    Ok(snap)
}
