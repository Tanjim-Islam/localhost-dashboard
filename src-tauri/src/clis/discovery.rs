use super::model::*;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) fn stopped(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Scan cancelled.".into())
    } else {
        Ok(())
    }
}
pub(super) struct Environment {
    pub home: PathBuf,
    pub vars: BTreeMap<String, PathBuf>,
    pub neutral: PathBuf,
    pub dirs: Vec<(PathBuf, Option<usize>)>,
    pub extensions: Vec<String>,
    pub additional: Vec<PathBuf>,
    #[cfg(windows)]
    pub registry: Option<super::windows::Registry>,
}
impl Environment {
    pub fn capture(neutral: &Path, additional: Vec<PathBuf>) -> Self {
        let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut dirs: Vec<_> = env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .filter(|p| p.is_absolute())
            .enumerate()
            .map(|(i, p)| (p, Some(i)))
            .collect();
        let vars: BTreeMap<_, _> = [
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "SCOOP",
            "CARGO_HOME",
            "PIPX_HOME",
            "PIPX_BIN_DIR",
            "UV_TOOL_DIR",
            "UV_TOOL_BIN_DIR",
            "JAVA_HOME",
            "GOPATH",
            "GOBIN",
            "PNPM_HOME",
            "BUN_INSTALL",
            "ANDROID_HOME",
            "ANDROID_SDK_ROOT",
            "MAVEN_HOME",
            "GRADLE_HOME",
            "NVM_HOME",
            "NVM_DIR",
            "SystemRoot",
        ]
        .iter()
        .filter_map(|&k| {
            env::var_os(k)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .map(|p| (k.to_owned(), p))
        })
        .collect();
        let mut known: Vec<PathBuf> =
            ["bin", ".cargo/bin", ".local/bin", ".bun/bin", "scoop/shims"]
                .iter()
                .map(|s| home.join(s))
                .collect();
        for (k, s) in [
            ("APPDATA", "npm"),
            ("LOCALAPPDATA", "pnpm"),
            ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
            ("LOCALAPPDATA", "Microsoft/WindowsApps"),
            ("LOCALAPPDATA", "Android/Sdk/platform-tools"),
            ("ProgramData", "chocolatey/bin"),
            ("SCOOP", "shims"),
        ] {
            if let Some(v) = vars.get(k) {
                known.push(v.join(s));
            }
        }
        for k in [
            "JAVA_HOME",
            "CARGO_HOME",
            "GOPATH",
            "GOBIN",
            "PNPM_HOME",
            "BUN_INSTALL",
            "ANDROID_HOME",
            "ANDROID_SDK_ROOT",
            "MAVEN_HOME",
            "GRADLE_HOME",
            "PIPX_BIN_DIR",
            "UV_TOOL_BIN_DIR",
        ] {
            if let Some(root) = vars.get(k) {
                known.extend([root.clone(), root.join("bin"), root.join("platform-tools")]);
            }
        }
        let mut versioned = vec![home.join(".nvm/versions/node")];
        if let Some(v) = vars.get("NVM_HOME") {
            versioned.push(v.clone());
        }
        if let Some(v) = vars.get("NVM_DIR") {
            versioned.push(v.join("versions/node"));
        }
        if let Some(v) = vars.get("LOCALAPPDATA") {
            versioned.push(v.join("Programs/Python"));
        }
        for p in versioned {
            for d in children(&p, 64) {
                let n = d
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if n.strip_prefix('v')
                    .or_else(|| n.strip_prefix("python"))
                    .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_digit()))
                {
                    known.extend([d.clone(), d.join("bin"), d.join("Scripts")]);
                }
            }
        }
        if cfg!(target_os = "macos") {
            known.extend([
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
                home.join("Library/pnpm"),
                home.join("Library/Android/sdk/platform-tools"),
            ]);
            let mut lists = children(Path::new("/etc/paths.d"), 128);
            lists.push("/etc/paths".into());
            for p in lists {
                if let Some(s) = read_text(&p, 65536) {
                    known.extend(s.lines().map(PathBuf::from).filter(|p| p.is_absolute()));
                }
            }
        }
        dirs.extend(known.into_iter().filter(|p| p.is_dir()).map(|p| (p, None)));
        let extensions = env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".into())
            .split(';')
            .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
            .collect();
        #[cfg(windows)]
        let registry = super::windows::Registry::read();
        #[cfg(windows)]
        dirs.extend(registry.dirs.iter().cloned().map(|p| (p, None)));
        Self {
            home,
            vars,
            neutral: neutral.into(),
            dirs,
            extensions,
            additional,
            #[cfg(windows)]
            registry: Some(registry),
        }
    }
    pub fn var(&self, k: &str, fallback: &str) -> PathBuf {
        self.vars
            .get(k)
            .cloned()
            .unwrap_or_else(|| self.home.join(fallback))
    }
}
pub(super) fn children(p: &Path, max: usize) -> Vec<PathBuf> {
    fs::read_dir(p)
        .into_iter()
        .flatten()
        .take(max)
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect()
}
fn expanded(roots: &[PathBuf], cancel: &AtomicBool) -> Result<(Vec<PathBuf>, bool), String> {
    let mut queue: VecDeque<_> = roots.iter().cloned().map(|p| (p, 0)).collect();
    let mut seen = BTreeSet::new();
    let mut dirs = vec![];
    let mut partial = false;
    while let Some((p, depth)) = queue.pop_front() {
        stopped(cancel)?;
        if !seen.insert(normal(&real(&p))) {
            continue;
        }
        if dirs.len() >= 2000 {
            partial = true;
            break;
        }
        dirs.push(p.clone());
        let Ok(entries) = fs::read_dir(&p) else {
            partial = true;
            continue;
        };
        for (i, entry) in entries.enumerate() {
            if i >= 4096 {
                partial = true;
                break;
            }
            let Ok(entry) = entry else {
                partial = true;
                continue;
            };
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() || !ft.is_dir() {
                continue;
            }
            if [
                "node_modules",
                ".git",
                ".cache",
                "cache",
                "caches",
                ".venv",
                "venv",
                "__pycache__",
                "$recycle.bin",
                "system volume information",
            ]
            .contains(&entry.file_name().to_string_lossy().to_lowercase().as_str())
            {
                continue;
            }
            if depth >= 8 || dirs.len() + queue.len() >= 2000 {
                partial = true;
                continue;
            }
            queue.push_back((entry.path(), depth + 1));
        }
    }
    Ok((dirs, partial))
}
fn console_pe(p: &Path) -> bool {
    let Ok(mut f) = fs::File::open(p) else {
        return false;
    };
    let mut head = [0; 64];
    if f.read_exact(&mut head).is_err() || &head[..2] != b"MZ" {
        return false;
    }
    let offset = u32::from_le_bytes(head[60..64].try_into().unwrap()) as u64;
    if !(64..=1024 * 1024).contains(&offset) || f.seek(SeekFrom::Start(offset)).is_err() {
        return false;
    }
    let mut pe = [0; 94];
    if f.read_exact(&mut pe).is_err() || &pe[..4] != b"PE\0\0" {
        return false;
    }
    matches!(u16::from_le_bytes([pe[24], pe[25]]), 0x10b | 0x20b)
        && u16::from_le_bytes([pe[92], pe[93]]) == 3
}
fn shim(path: &Path, name: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    use regex::Regex;
    use std::sync::LazyLock;
    static PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(?:^|[/\\])node_modules[/\\]((?:@[a-z0-9._-]+[/\\])?[a-z0-9._-]+)"#)
            .unwrap()
    });
    static QUOTED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"["']([^"'\r\n]+)["']"#).unwrap());
    let dir = path.parent()?;
    let content = read_text(path, 65536)?;
    let expanded = content
        .replace("%~dp0", &(path_string(dir) + "\\"))
        .replace("%dp0%", &path_string(dir))
        .replace("$basedir", &path_string(dir))
        .replace("$PSScriptRoot", &path_string(dir));
    let mut roots = BTreeSet::new();
    for quoted in QUOTED.captures_iter(&expanded) {
        let value = Path::new(&quoted[1]);
        if !value.is_absolute() || quoted[1].contains(['%', '$']) {
            continue;
        }
        for parent in value.ancestors().skip(1) {
            if parent
                .file_name()
                .is_some_and(|v| v.eq_ignore_ascii_case("node_modules"))
            {
                let Some(cap) = PACKAGE.captures(&quoted[1]) else {
                    continue;
                };
                let package = cap[1].replace('\\', "/");
                if valid_pkg("npm", &package) {
                    roots.insert((real(&parent.join(&package)), package));
                }
                break;
            }
        }
    }
    for cap in PACKAGE.captures_iter(&content) {
        let package = cap[1].replace('\\', "/");
        if valid_pkg("npm", &package) {
            roots.insert((real(&dir.join("node_modules").join(&package)), package));
        }
    }
    for (root, package) in roots {
        let Some(doc) = read_doc(&root.join("package.json")) else {
            continue;
        };
        if doc["name"] != package {
            continue;
        }
        let rel = doc["bin"].get(name).and_then(Value::as_str).or_else(|| {
            (package.rsplit('/').next() == Some(name))
                .then(|| doc["bin"].as_str())
                .flatten()
        });
        let Some(rel) = rel else { continue };
        let Some(mut target) = super::packages::child_path(&root, rel) else {
            continue;
        };
        if !target.exists()
            && target.extension().is_none()
            && target.with_extension("exe").is_file()
        {
            target = target.with_extension("exe")
        }
        return Some((target, Some(root)));
    }
    if content.len() > 2048 || content.lines().count() > 20 {
        return None;
    }
    let targets: BTreeSet<_> = QUOTED
        .captures_iter(&expanded)
        .filter_map(|q| {
            let q = q[1].trim();
            if q.contains(['%', '$']) {
                return None;
            }
            let p = dir.join(q);
            if !p.starts_with(dir)
                || p.components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return None;
            }
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("com"))
                .then_some(p)
        })
        .collect();
    (targets.len() == 1).then(|| (targets.first().unwrap().clone(), None))
}
fn bundled_perl(path: &Path, name: &str) -> bool {
    if name == "perl" {
        return false;
    }
    let Some(bin) = path
        .parent()
        .filter(|p| p.file_name().is_some_and(|v| v.eq_ignore_ascii_case("bin")))
    else {
        return false;
    };
    let Some(tools) = bin.parent().filter(|p| {
        p.file_name()
            .is_some_and(|v| v.eq_ignore_ascii_case("c") || v.eq_ignore_ascii_case("perl"))
    }) else {
        return false;
    };
    let Some(root) = tools.parent() else {
        return false;
    };
    root.join("perl/bin/perl.exe").is_file()
        && read_text(&root.join("README.txt"), 65536).is_some_and(|s| {
            s.lines()
                .any(|l| l.starts_with("=== Strawberry Perl (") && l.ends_with(" README ==="))
        })
}
#[derive(Clone)]
pub(super) struct Endpoint {
    pub path: PathBuf,
    pub canonical: PathBuf,
    pub name: String,
    pub ext: String,
    pub order: Option<(usize, usize)>,
    pub data: Value,
}
pub(super) fn inspect(
    path: &Path,
    name: &str,
    index: Option<usize>,
    env: &Environment,
    declared: bool,
) -> Option<Endpoint> {
    if !command_name(name) {
        return None;
    }
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if cfg!(windows)
        && !declared
        && !matches!(ext.as_str(), "exe" | "com" | "cmd" | "bat" | "ps1" | "")
    {
        return None;
    }
    let link = fs::symlink_metadata(path).ok()?;
    if link.is_dir() {
        return None;
    }
    if cfg!(windows) && !declared && by_command(name).is_none() {
        let admitted = match ext.as_str() {
            "cmd" | "bat" | "ps1" => true,
            "exe" => console_pe(path),
            _ => false,
        };
        if !admitted {
            return None;
        }
    }
    let meta = if link.is_symlink() {
        fs::metadata(path).ok()
    } else {
        Some(link.clone())
    };
    let canonical = real(path);
    let target = meta.as_ref().is_some_and(|m| m.is_file());
    let alias = cfg!(windows)
        && normal(path)
            .replace('\\', "/")
            .contains("/appdata/local/microsoft/windowsapps/");
    let kind = if alias {
        "app-alias"
    } else if link.is_symlink() {
        "symlink"
    } else if ["cmd", "bat", "ps1"].contains(&ext.as_str()) {
        "shim"
    } else if cfg!(windows) && ext.is_empty() {
        "script"
    } else {
        "native"
    };
    if alias && !declared && name != "winget" {
        return None;
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        let executable = target
            && meta
                .as_ref()
                .is_some_and(|m| m.permissions().mode() & 0o111 != 0);
        if !declared && !executable {
            return None;
        }
        executable
    };
    #[cfg(windows)]
    let executable = target && ["exe", "com", "cmd", "bat", "ps1"].contains(&ext.as_str());
    let order = index.and_then(|i| {
        if cfg!(windows) {
            env.extensions
                .iter()
                .position(|e| e == &ext)
                .map(|j| (i, j))
        } else {
            Some((i, 0))
        }
    });
    let m = meta.as_ref().unwrap_or(&link);
    let modified = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let mut data = json!({
        "id": id("endpoint",json!({"path":normal(path),"command":name})),
        "commandName": name,
        "kind": kind,
        "path": path_string(path),
        "canonicalPath": path_string(&canonical),
        "accessible": true,
        "targetExists": target,
        "executable": executable,
        "fileSize": m.len(),
        "modifiedAt": modified,
    });
    if let Some((i, j)) = order {
        data["pathIndex"] = json!(i);
        data["pathextIndex"] = json!(j);
    }
    if link.is_symlink() {
        data["symlinkTarget"] = json!(path_string(&canonical));
    }
    if cfg!(windows) && ["cmd", "ps1", "bat", ""].contains(&ext.as_str()) {
        if let Some((target, root)) = shim(&canonical, name) {
            data["shimTarget"] = json!(path_string(&target));
            data["targetExists"] = json!(target.is_file());
            if let Some(r) = root {
                data["shimPackageRoot"] = json!(path_string(&r));
            }
        }
    }
    if cfg!(windows) && bundled_perl(&canonical, name) {
        data["bundledWith"] = json!("strawberry-perl");
    }
    data["fingerprint"] = json!(id(
        "fp",
        json!({
            "path": normal(path),
            "canonicalPath": normal(&canonical),
            "fileSize": m.len(),
            "modifiedAt": modified,
            "targetExists": data["targetExists"],
            "shimTarget": data["shimTarget"],
            "accessible": true,
        })
    ));
    Some(Endpoint {
        path: path.into(),
        canonical,
        name: name.into(),
        ext,
        order,
        data,
    })
}
pub(super) fn enumerate(
    env: &Environment,
    cancel: &AtomicBool,
) -> Result<(Vec<Endpoint>, Vec<Value>), String> {
    let start = now();
    let (extra, mut partial) = expanded(&env.additional, cancel)?;
    let mut dirs = env.dirs.clone();
    dirs.extend(extra.into_iter().map(|p| (p, None)));
    let mut seen = BTreeSet::new();
    let mut es = vec![];
    for (dir, index) in dirs {
        stopped(cancel)?;
        let canonical = normal(&real(&dir));
        let system = env
            .vars
            .get("SystemRoot")
            .is_some_and(|root| Path::new(&canonical).starts_with(normal(root)));
        if !seen.insert(canonical) {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    partial = true
                }
                continue;
            }
        };
        for (i, item) in entries.enumerate() {
            if i >= 20000 || es.len() >= 12000 {
                partial = true;
                break;
            }
            if i % 64 == 0 {
                stopped(cancel)?
            }
            let Ok(item) = item else {
                partial = true;
                continue;
            };
            let path = item.path();
            let name = if cfg!(windows) {
                path.file_stem()
            } else {
                path.file_name()
            };
            let Some(name) = name.and_then(|s| s.to_str()) else {
                continue;
            };
            if system && by_command(name).is_none() {
                continue;
            }
            if let Some(endpoint) = inspect(&path, &name.to_lowercase(), index, env, false) {
                es.push(endpoint)
            }
        }
    }
    let sources = vec![source(
        "path",
        "Executable directories",
        if partial { "failed" } else { "success" },
        es.len(),
        start,
    )];
    Ok((es, sources))
}
