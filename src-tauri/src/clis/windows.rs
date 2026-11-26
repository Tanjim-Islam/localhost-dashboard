use super::{
    discovery::{Endpoint, Environment},
    model::*,
    packages::Package,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    RegKey,
};

struct Root {
    directory: PathBuf,
    display: String,
    version: Option<String>,
    publisher: Option<String>,
    scope: &'static str,
}
pub(super) struct Registry {
    roots: Vec<Root>,
    pub dirs: Vec<PathBuf>,
    pub source: Value,
}
fn clean(text: String) -> Option<String> {
    let v = text.trim();
    (!v.is_empty() && v.len() < 512 && !v.chars().any(char::is_control)).then(|| v.to_owned())
}
fn path(value: &str) -> Option<PathBuf> {
    let p = PathBuf::from(value.trim().trim_matches('"'));
    (p.is_absolute()
        && p.parent().is_some()
        && value.len() <= 1024
        && !value.chars().any(char::is_control))
    .then_some(p)
}
impl Registry {
    pub fn read() -> Self {
        let started = now();
        let mut roots = vec![];
        let mut dirs = vec![];
        let mut partial = false;
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
        for (h, k) in [
            (&user, r"Environment"),
            (
                &machine,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            ),
        ] {
            if let Ok(key) = h.open_subkey(k) {
                if let Ok(s) = key.get_value::<String, _>("Path") {
                    dirs.extend(
                        std::env::split_paths(&s).filter(|p| p.is_absolute() && p.is_dir()),
                    );
                }
            }
        }
        for (h, k, scope) in [
            (&user, r"Software\Microsoft\Windows\CurrentVersion", "user"),
            (
                &machine,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion",
                "machine",
            ),
            (
                &machine,
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion",
                "machine",
            ),
        ] {
            if let Some(apps) = (!k.contains("WOW6432Node"))
                .then(|| h.open_subkey(format!("{k}\\App Paths")).ok())
                .flatten()
            {
                for name in apps.enum_keys().take(501).flatten() {
                    if let Some(p) = apps
                        .open_subkey(&name)
                        .ok()
                        .and_then(|key| key.get_value::<String, _>("").ok())
                        .and_then(|s| path(&s))
                    {
                        if let Some(parent) = p.parent() {
                            dirs.push(parent.into());
                        }
                    }
                }
            }
            if let Ok(apps) = h.open_subkey(format!("{k}\\Uninstall")) {
                for (index, entry) in apps.enum_keys().enumerate() {
                    if index >= 500 {
                        partial = true;
                        break;
                    }
                    let Some(key) = entry.ok().and_then(|name| apps.open_subkey(name).ok()) else {
                        continue;
                    };
                    let Some(directory) = key
                        .get_value::<String, _>("InstallLocation")
                        .ok()
                        .and_then(|v| path(&v))
                        .filter(|v| v.is_dir())
                    else {
                        continue;
                    };
                    let Some(display) = key
                        .get_value::<String, _>("DisplayName")
                        .ok()
                        .and_then(clean)
                    else {
                        continue;
                    };
                    let version = key
                        .get_value::<String, _>("DisplayVersion")
                        .ok()
                        .and_then(clean);
                    let publisher = key.get_value::<String, _>("Publisher").ok().and_then(clean);
                    let dir = real(&directory);
                    if dir.components().count() < 3 {
                        continue;
                    }
                    if [
                        "USERPROFILE",
                        "ProgramFiles",
                        "ProgramFiles(x86)",
                        "APPDATA",
                        "LOCALAPPDATA",
                    ]
                    .iter()
                    .filter_map(std::env::var_os)
                    .map(PathBuf::from)
                    .any(|root| {
                        normal(&dir) == normal(&root)
                            || root
                                .parent()
                                .is_some_and(|parent| normal(parent) == normal(&dir))
                    }) {
                        continue;
                    }
                    dirs.push(dir.clone());
                    for sub in ["bin", "Scripts", "cmd"] {
                        let sub = dir.join(sub);
                        if sub.is_dir() {
                            dirs.push(sub)
                        }
                    }
                    roots.push(Root {
                        directory: dir,
                        display,
                        version,
                        publisher,
                        scope,
                    });
                }
            }
        }
        roots.sort_by_key(|r| std::cmp::Reverse(r.directory.components().count()));
        let source = source(
            "windows-registry",
            "Windows registry",
            if partial { "failed" } else { "success" },
            roots.len(),
            started,
        );
        Self {
            roots,
            dirs,
            source,
        }
    }
    pub fn attribute(&self, env: &Environment, es: &mut [Endpoint]) -> Vec<Package> {
        let mut result = BTreeMap::new();
        let mut metadata = BTreeMap::new();
        for e in es {
            let p = normal(&e.canonical);
            let root = self
                .roots
                .iter()
                .find(|r| Path::new(&p).starts_with(normal(&r.directory)));
            if let Some(root) = root {
                e.data["ownerName"] = json!(root.display);
                if let Some(v) = &root.publisher {
                    e.data["publisher"] = json!(v);
                }
                if let Some(def) = by_command(&e.name) {
                    let p = result
                        .entry((normal(&root.directory), def.id.clone()))
                        .or_insert_with(|| {
                            let mut pkg = Package::new(
                                "registry",
                                &root.display,
                                root.version.as_deref(),
                                &root.directory,
                                &root.directory,
                                None,
                            );
                            pkg.product = def.id.clone();
                            pkg.identity["scope"] = json!(root.scope);
                            pkg
                        });
                    p.add(&e.name, &e.path);
                }
            }
            if e.ext == "exe" {
                let version = metadata
                    .entry(p)
                    .or_insert_with(|| version_info(&e.canonical));
                if let Some(v) = &version.publisher {
                    if e.data["publisher"].is_null() {
                        e.data["publisher"] = json!(v);
                    }
                }
                if let (Some(name), Some(v)) = (&version.product, &version.version) {
                    if name.eq_ignore_ascii_case(&e.name)
                        && v.len() <= 128
                        && v.starts_with(|c: char| c.is_ascii_digit())
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
                    {
                        e.data["fileVersion"] = json!(v);
                    }
                }
            }
        }
        let _ = env;
        result.into_values().collect()
    }
}
#[derive(Default)]
struct VersionInfo {
    publisher: Option<String>,
    product: Option<String>,
    version: Option<String>,
}
fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}
fn version_info(p: &Path) -> VersionInfo {
    let file = wide(p.as_os_str());
    let mut ignored = 0;
    // Windows fills a caller-owned aligned resource buffer. All slices below are bounded by that buffer.
    let len = unsafe { GetFileVersionInfoSizeW(file.as_ptr(), &mut ignored) };
    if len == 0 || len > 2 * 1024 * 1024 {
        return VersionInfo::default();
    }
    let mut buf = vec![0u32; (len as usize).div_ceil(4)];
    if unsafe { GetFileVersionInfoW(file.as_ptr(), 0, len, buf.as_mut_ptr().cast()) } == 0 {
        return VersionInfo::default();
    }
    let query = |key: &str, is_text: bool| -> Option<Vec<u16>> {
        let key = wide(OsStr::new(key));
        let mut pointer = null_mut();
        let mut size = 0;
        if unsafe { VerQueryValueW(buf.as_ptr().cast(), key.as_ptr(), &mut pointer, &mut size) }
            == 0
            || pointer.is_null()
        {
            return None;
        }
        let n = if is_text {
            size as usize
        } else {
            size as usize / 2
        };
        let base = buf.as_ptr() as usize;
        let address = pointer as usize;
        if n == 0
            || n > 512
            || address % 2 != 0
            || address < base
            || address - base > len as usize
            || n * 2 > len as usize - (address - base)
        {
            return None;
        }
        Some(unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), n) }.to_vec())
    };
    let trans = query(r"\VarFileInfo\Translation", false).unwrap_or_else(|| vec![0x409, 0x4b0]);
    let field = |field: &str| -> Option<String> {
        for pair in trans.chunks_exact(2) {
            let key = format!(r"\StringFileInfo\{:04x}{:04x}\{field}", pair[0], pair[1]);
            if let Some(s) = query(&key, true) {
                if let Some(v) = clean(String::from_utf16_lossy(&s).trim_end_matches('\0').into()) {
                    return Some(v);
                }
            }
        }
        None
    };
    VersionInfo {
        publisher: field("CompanyName"),
        product: field("ProductName"),
        version: field("ProductVersion"),
    }
}
