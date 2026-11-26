use super::now;
use crate::storage::{read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const FILE: &str = "recent-scripts.json";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    #[serde(rename = "type")]
    pub kind: String,
    pub script_path: PathBuf,
    script_name: String,
    first_seen: u64,
    last_used: u64,
    use_count: u64,
}

impl Entry {
    fn id(&self) -> String {
        format!(
            "{}:{}",
            self.kind,
            self.script_path.to_string_lossy().to_lowercase()
        )
    }
}

#[derive(Clone)]
pub(super) struct Recent {
    dir: PathBuf,
    entries: Vec<Entry>,
}

impl Recent {
    pub(super) fn new(dir: &Path) -> Result<Self, String> {
        let saved = read_json(dir, FILE, json!({"scripts":[]}))?;
        let mut entries: Vec<Entry> = serde_json::from_value(saved["scripts"].clone())
            .map_err(|_| "The recent scripts file could not be read.".to_string())?;
        entries.sort_by_key(|e| std::cmp::Reverse(e.last_used));
        entries.truncate(40);
        Ok(Self {
            dir: dir.to_owned(),
            entries,
        })
    }
    pub(super) fn list(&self, kind: &str) -> Value {
        Value::Array(
            self.entries
                .iter()
                .filter(|e| e.kind == kind)
                .map(|e| {
                    let mut row = json!(e);
                    row["id"] = json!(e.id());
                    row
                })
                .collect(),
        )
    }
    pub(super) fn get(&self, kind: &str, id: &str) -> Result<Entry, String> {
        self.entries
            .iter()
            .find(|e| e.kind == kind && e.id() == id)
            .cloned()
            .ok_or_else(|| "Recent script was not found.".into())
    }
    pub(super) fn remember(&mut self, kind: &str, path: &Path, display: Option<&str>) {
        let now = now();
        let id = format!("{}:{}", kind, path.to_string_lossy().to_lowercase());
        let prior = self
            .entries
            .iter()
            .position(|e| e.id() == id)
            .map(|i| self.entries.remove(i));
        let entry = Entry {
            kind: kind.into(),
            script_path: path.to_owned(),
            script_name: display
                .map(str::to_owned)
                .or_else(|| prior.as_ref().map(|e| e.script_name.clone()))
                .unwrap_or_else(|| {
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                }),
            first_seen: prior.as_ref().map_or(now, |e| e.first_seen),
            last_used: now,
            use_count: prior.as_ref().map_or(1, |e| e.use_count.saturating_add(1)),
        };
        self.entries.insert(0, entry);
        self.entries.truncate(40);
    }
    pub(super) fn remove(&mut self, kind: &str, id: &str) {
        self.entries.retain(|e| e.kind != kind || e.id() != id);
    }
    pub(super) fn persist(&self) -> Result<(), String> {
        write_json(&self.dir, FILE, &json!({"scripts":self.entries}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_records_preserves_timestamps_and_limits_and_never_deletes_script() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("My Script.ahk");
        std::fs::write(&path, b"; fixture").unwrap();
        write_json(
            dir.path(),
            FILE,
            &json!({"scripts":[{"type":"ahk","scriptPath":path,
            "scriptName":"My Script","firstSeen":10,"lastUsed":11,"useCount":4}]}),
        )
        .unwrap();
        let mut recent = Recent::new(dir.path()).unwrap();
        recent.remember("ahk", &path, None);
        recent.persist().unwrap();
        let mut again = Recent::new(dir.path()).unwrap();
        let list = again.list("ahk");
        assert_eq!(list[0]["firstSeen"], 10);
        assert_eq!(list[0]["useCount"], 5);
        assert!(again.list("automator").as_array().unwrap().is_empty());
        again.remove("ahk", list[0]["id"].as_str().unwrap());
        assert!(path.exists());
        assert_eq!(again.list("ahk"), json!([]));
        for i in 0..48 {
            again.remember("ahk", &dir.path().join(format!("{i}.ahk")), None);
        }
        assert_eq!(again.entries.len(), 40);
        assert!(again.entries[0].script_path.ends_with("47.ahk"));
    }
}
