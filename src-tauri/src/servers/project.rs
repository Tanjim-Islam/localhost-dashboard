use super::native::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub fn hash(input: &str) -> String {
    format!("{:x}", Sha256::digest(input.as_bytes()))[..32].to_string()
}
pub fn display(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = path.strip_prefix(r"\\?\") {
            return drive.to_owned();
        }
    }
    path.into_owned()
}
pub fn path_key(p: &Path) -> String {
    let s = display(p);
    if cfg!(windows) {
        s.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        s.trim_end_matches('/').to_string()
    }
}
pub fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(limit)
        .collect()
}
pub fn association(cwd: &Path, exe: &Path, argv: &[OsString]) -> String {
    let mut parts = vec![path_key(cwd), path_key(exe)];
    let mut iter = argv.iter().skip(1).map(|v| v.to_string_lossy()).peekable();
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    while let Some(arg) = iter.next() {
        if (arg == "-p" || arg == "--port") && iter.peek().is_some_and(|v| numeric(v)) {
            iter.next();
            continue;
        }
        if arg.strip_prefix("--port=").is_some_and(numeric) {
            continue;
        }
        parts.push(arg.into_owned())
    }
    hash(&parts.join("\0"))
}
#[derive(Clone)]
pub struct Evidence {
    pub directory: PathBuf,
    pub name: String,
    pub service_name: Option<String>,
}
fn project_root(start: &Path) -> Option<Evidence> {
    let start = start.canonicalize().ok()?;
    if !start.is_dir() {
        return None;
    }
    let slash = display(&start).replace('\\', "/").to_lowercase();
    if [
        "/node_modules/",
        "/.cargo/",
        "/.rustup/",
        "/windows/",
        "/program files/",
        "/program files (x86)/",
        "/windowsapps/",
        ".app/contents/",
    ]
    .iter()
    .any(|p| slash.contains(p) || slash.ends_with(p.trim_end_matches('/')))
        || [
            "/opt/homebrew",
            "/opt/local",
            "/usr/local/cellar",
            "/usr/local/homebrew",
            "/usr/local/lib",
            "/usr/local/bin",
            "/usr/local/opt",
            "/usr/local/var",
            "/usr/local/sbin",
        ]
        .iter()
        .any(|p| slash == *p || slash.starts_with(&format!("{p}/")))
    {
        return None;
    }
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let mut nearest = None;
    let mut workspace = None;
    for dir in start.ancestors().take(12) {
        let Some(basename) = dir.file_name().and_then(|s| s.to_str()) else {
            break;
        };
        if home.as_ref().is_some_and(|p| path_key(p) == path_key(dir))
            || ["appdata", "programdata", "users", "tmp", "temp"]
                .contains(&basename.to_lowercase().as_str())
        {
            break;
        }
        let manifest = fs::File::open(dir.join("package.json"))
            .ok()
            .and_then(|file| {
                let mut buf = Vec::new();
                file.take(262145).read_to_end(&mut buf).ok()?;
                if buf.len() > 262144 {
                    return None;
                }
                serde_json::from_slice::<Value>(&buf).ok()
            });
        let git = dir.join(".git").exists();
        let name = clean(
            manifest
                .as_ref()
                .and_then(|m| m["name"].as_str())
                .unwrap_or(basename),
            120,
        );
        if nearest.is_none()
            && (manifest.is_some()
                || git
                || ["pyproject.toml", "Cargo.toml", "go.mod"]
                    .iter()
                    .any(|f| dir.join(f).is_file()))
        {
            nearest = Some((dir.to_owned(), name.clone()));
        }
        if manifest
            .as_ref()
            .is_some_and(|m| !m["workspaces"].is_null())
            || dir.join("pnpm-workspace.yaml").is_file()
        {
            workspace = Some((dir.to_owned(), name.clone()));
        }
        if git {
            workspace.get_or_insert((dir.to_owned(), name));
            break;
        }
    }
    let (nearest_dir, nearest_name) = nearest?;
    let (directory, name) =
        workspace.unwrap_or_else(|| (nearest_dir.clone(), nearest_name.clone()));
    let service_name = (nearest_dir != directory).then_some(nearest_name);
    Some(Evidence {
        directory,
        name,
        service_name,
    })
}
pub fn identify(cwd: &Path, argv: &[OsString]) -> Option<Evidence> {
    let cwd_root = project_root(cwd);
    let script_root = argv
        .iter()
        .skip(1)
        .map(Path::new)
        .find(|p| p.is_absolute())
        .and_then(|p| {
            let dir = p
                .ancestors()
                .find(|c| c.file_name().is_some_and(|n| n == "node_modules"))
                .and_then(Path::parent)
                .or_else(|| p.parent())?;
            project_root(dir)
        });
    match (cwd_root, script_root) {
        (Some(a), Some(b)) if path_key(&a.directory) != path_key(&b.directory) => None,
        (a, b) => a.or(b),
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub directory: String,
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub bookmarked: bool,
    #[serde(default)]
    pub ignored: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_seen: u64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub key: String,
    pub first_seen: u64,
}
impl Reference {
    pub fn valid(&self) -> bool {
        self.first_seen > 0
            && self.key.split_once(':').is_some_and(|(p, n)| {
                p.parse::<u32>()
                    .is_ok_and(|p| p > 0 && p <= i32::MAX as u32)
                    && n.parse::<u16>().is_ok_and(|n| n > 0)
            })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(flatten)]
    pub reference: Reference,
    pub pid: u32,
    pub port: u16,
    pub service_name: String,
    pub last_seen: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_started: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Activity {
    pub id: String,
    pub at: u64,
    pub kind: String,
    pub service: Record,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub port: String,
    pub text: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Model {
    pub schema_version: u32,
    pub legacy_notes_migrated: bool,
    pub projects: Vec<Project>,
    pub associations: HashMap<String, Option<String>>,
    pub last_observed: Vec<Record>,
    pub recently_stopped: Vec<Record>,
    pub activity: Vec<Activity>,
    pub legacy_notes: Vec<Note>,
}
impl Model {
    pub fn load(dir: &Path) -> Result<Self> {
        let data = crate::storage::read_json(dir, "projects.json", json!({}))?;
        let mut model = match data.get("state") {
            None => Self::default(),
            Some(state) if matches!(state["schemaVersion"].as_u64(), Some(1 | 2)) => {
                serde_json::from_value(state.clone())
                    .map_err(|_| "Could not read saved projects.")?
            }
            Some(_) => return Err("Unsupported project store version.".into()),
        };
        model.schema_version = 2;
        model.projects.truncate(1000);
        model.recently_stopped.truncate(100);
        model.activity.truncate(500);
        model.last_observed.truncate(512);
        if !model.legacy_notes_migrated {
            let old = crate::storage::read_json(dir, "port-notes.json", json!({}))?;
            if let Some(notes) = old["notes"].as_object() {
                model.legacy_notes = notes
                    .iter()
                    .filter_map(|(k, v)| {
                        if !(1..=5).contains(&k.len()) || !k.bytes().all(|c| c.is_ascii_digit()) {
                            return None;
                        }
                        let text = v.as_str().filter(|v| !v.trim().is_empty())?;
                        Some(Note {
                            id: format!("legacy-{k}"),
                            port: k.clone(),
                            text: clean(text, 64000),
                        })
                    })
                    .collect();
            }
            model.legacy_notes_migrated = true;
        }
        Ok(model)
    }
    pub fn project(&self, id: Option<&str>) -> Option<&Project> {
        self.projects.iter().find(|p| Some(p.id.as_str()) == id)
    }
    pub fn assign(
        &mut self,
        evidence: Option<&Evidence>,
        key: &str,
        now: u64,
    ) -> (Option<Project>, String) {
        if let Some(id) = self.associations.get(key) {
            let project = self
                .projects
                .iter_mut()
                .find(|p| Some(&p.id) == id.as_ref());
            if let Some(p) = project {
                p.last_seen = now;
                return (Some(p.clone()), "manual".into());
            }
            return (None, "manual".into());
        }
        if let Some(e) = evidence {
            let id = hash(&path_key(&e.directory));
            if let Some(p) = self.projects.iter_mut().find(|p| p.id == id) {
                p.last_seen = now;
                return (Some(p.clone()), "detected".into());
            }
            if self.projects.len() < 1000 {
                let p = Project {
                    id,
                    directory: display(&e.directory),
                    name: e.name.clone(),
                    notes: String::new(),
                    pinned: false,
                    bookmarked: false,
                    ignored: false,
                    created_at: now,
                    last_seen: now,
                };
                self.projects.push(p.clone());
                return (Some(p), "detected".into());
            }
        }
        (None, String::new())
    }
    pub fn event(&mut self, kind: &str, record: Record, at: u64) {
        self.activity.insert(
            0,
            Activity {
                id: uuid::Uuid::new_v4().to_string(),
                at,
                kind: kind.to_string(),
                service: record,
            },
        );
        self.activity.truncate(500)
    }
    pub fn reconcile(
        &mut self,
        current: Vec<Record>,
        live: &HashMap<String, super::Row>,
        now: u64,
    ) {
        let previous = std::mem::take(&mut self.last_observed);
        let mut current = current;
        for old in &previous {
            if current.iter().any(|r| r.reference == old.reference) {
                continue;
            }
            if let Some(r) = live
                .get(&old.reference.key)
                .filter(|r| r.record.reference == old.reference)
            {
                if r.discovery == "unidentified" && current.len() < 512 {
                    let mut preserved = old.clone();
                    preserved.last_seen = now;
                    current.push(preserved);
                }
                continue;
            }
            let mut stopped = old.clone();
            stopped.last_status = Some(stopped.status.clone());
            stopped.status = "listener-disappeared".into();
            stopped.stopped_at = Some(now);
            self.event("listener-disappeared", stopped.clone(), now);
            self.recently_stopped.insert(0, stopped);
        }
        self.recently_stopped.truncate(100);
        for next in &current {
            if previous.iter().any(|r| r.reference == next.reference) {
                continue;
            }
            if let Some(prior) = previous
                .iter()
                .chain(&self.recently_stopped)
                .find(|p| p.port == next.port)
            {
                if prior.pid != next.pid
                    || (prior.process_started.is_some()
                        && prior.process_started != next.process_started)
                {
                    let kind = if prior.project_id.is_some() && prior.project_id == next.project_id
                    {
                        "process-changed"
                    } else {
                        "port-reused"
                    };
                    self.event(kind, next.clone(), now);
                }
            }
            let returned = next.service_id.is_some()
                && self
                    .recently_stopped
                    .iter()
                    .any(|r| r.service_id == next.service_id)
                && !previous.iter().any(|r| {
                    r.service_id == next.service_id
                        && current.iter().any(|c| r.reference == c.reference)
                });
            self.event(
                if returned {
                    "available-again"
                } else {
                    "discovered"
                },
                next.clone(),
                now,
            );
        }
        self.last_observed = current;
    }
}
