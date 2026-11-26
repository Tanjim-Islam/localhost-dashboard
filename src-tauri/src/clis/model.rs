use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Definition {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub commands: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub packages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub foundational: bool,
    #[serde(default)]
    pub application_cli: bool,
    #[serde(default)]
    pub always_probe_version: bool,
    #[serde(default)]
    pub prefer_version_probe: bool,
    pub version_probe: Option<Probe>,
    pub incomplete_probe: Option<Probe>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Probe {
    pub command_name: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub platforms: Vec<String>,
}
pub(super) static CATALOGUE: LazyLock<Vec<Definition>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalogue.json")).expect("valid CLI catalogue")
});
pub(super) fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else {
        "darwin"
    }
}
pub(super) fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        v => v,
    }
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn definitions() -> impl Iterator<Item = &'static Definition> {
    CATALOGUE
        .iter()
        .filter(|d| d.platforms.is_empty() || d.platforms.iter().any(|p| p == platform()))
}
pub(super) fn by_command(name: &str) -> Option<&'static Definition> {
    definitions().find(|d| d.commands.iter().any(|c| c.eq_ignore_ascii_case(name)))
}
pub(super) fn by_package(source: &str, name: &str) -> Option<&'static Definition> {
    definitions().find(|d| {
        d.packages
            .get(source)
            .into_iter()
            .chain(
                ["pnpm", "yarn-classic", "bun"]
                    .contains(&source)
                    .then(|| d.packages.get("npm"))
                    .flatten(),
            )
            .flatten()
            .any(|s| s.eq_ignore_ascii_case(name))
    })
}
pub(super) fn id(prefix: &str, mut data: Value) -> String {
    data.sort_all_objects();
    let hash = Sha256::digest(data.to_string().as_bytes());
    format!("{prefix}-{}", &format!("{hash:x}")[..24])
}
pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub(super) fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
pub(super) fn strings(v: &Value) -> impl Iterator<Item = &str> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str)
}
pub(super) fn find<'a>(v: &'a Value, group: &str, key: &Value) -> Option<&'a Value> {
    list(v, group).iter().find(|item| &item["id"] == key)
}
pub(super) fn path_string(p: &Path) -> String {
    p.to_string_lossy()
        .strip_prefix(r"\\?\UNC\")
        .map(|v| format!(r"\\{v}"))
        .unwrap_or_else(|| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}
pub(super) fn normal(p: &Path) -> String {
    let s = path_string(p);
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}
pub(super) fn real(p: &Path) -> PathBuf {
    fs::canonicalize(p)
        .map(|path| PathBuf::from(path_string(&path)))
        .unwrap_or_else(|_| p.to_owned())
}
pub(super) fn command_name(n: &str) -> bool {
    (1..=128).contains(&n.len())
        && n.as_bytes()[0].is_ascii_alphanumeric()
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}
pub(super) fn valid_pkg(source: &str, n: &str) -> bool {
    if n.len() > 215 || n.is_empty() {
        return false;
    }
    let mut parts = n.split('/');
    let head = parts.next().unwrap_or_default();
    let valid = |s: &str| command_name(s) && !s.contains("..");
    match (source, parts.next(), parts.next()) {
        ("npm", Some(name), None) => head.strip_prefix('@').is_some_and(valid) && valid(name),
        ("homebrew-formula", Some(tap), Some(formula)) => {
            valid(head) && valid(tap) && valid(formula) && parts.next().is_none()
        }
        (_, None, None) => valid(head),
        _ => false,
    }
}
pub(super) fn read_text(path: &Path, max: u64) -> Option<String> {
    use std::io::Read;
    let f = fs::File::open(path).ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() || m.len() > max {
        return None;
    }
    let mut buf = String::new();
    f.take(max + 1).read_to_string(&mut buf).ok()?;
    (buf.len() as u64 <= max).then_some(buf)
}
pub(super) fn read_doc(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_text(path, 2 * 1024 * 1024)?).ok()
}
pub(super) fn source(id: &str, label: &str, status: &str, count: usize, started: u64) -> Value {
    let mut v = json!({"sourceId":id,"label":label,"status":status,"startedAt":started,"finishedAt":now(),"recordCount":count});
    if status == "failed" {
        v["errorCode"] = json!("SOURCE_UNAVAILABLE");
        v["message"] = json!("This source could not be fully inspected.");
    }
    v
}
pub(super) fn key_id(value: &Value) -> Result<&str, String> {
    let s = value.as_str().unwrap_or("");
    if (8..=96).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        Ok(s)
    } else {
        Err("Invalid CLI reference.".into())
    }
}
pub(super) fn empty() -> Value {
    json!({"schemaVersion":2,"inventory":null,"comparisonBaseline":null,"scanDirectories":[],"scanAttempts":[],"uninstallAudits":[],"lastScanStartedAt":null,"lastSuccessfulScanAt":null,"lastCompletedScanAt":null,"lastScanStatus":"idle"})
}
pub(super) fn prepend(store: &mut Value, key: &str, value: Value, limit: usize) {
    let mut entries = list(store, key).to_vec();
    entries.insert(0, value);
    entries.truncate(limit);
    store[key] = json!(entries)
}
pub(super) fn dirs(store: &Value) -> Vec<PathBuf> {
    strings(&store["scanDirectories"])
        .take(20)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}
pub(super) fn dir_items(store: &Value) -> Value {
    json!(dirs(store)
        .iter()
        .map(|p| json!({"id":id("scan-folder",json!({"path":normal(p)})),"path":path_string(p)}))
        .collect::<Vec<_>>())
}
