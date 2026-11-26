use rusty_leveldb::{Options, DB};
use serde_json::{json, Value};
use std::{fs, path::Path};

// Chromium prefixes file-origin localStorage keys with its origin, a NUL and
// a one-byte string encoding. All supported dashboard preference values are ASCII.
const KEYS: &[&str] = &[
    "dashboard:activeTab",
    "dashboard:serversView",
    "dashboard:themeMode",
    "dashboard:lightPalette",
    "dashboard:darkPalette",
    "dashboard:fontPreset",
];

pub fn legacy_preferences(path: &Path) -> Result<Value, String> {
    let mut prefs = json!({});
    if !path.join("CURRENT").is_file() {
        return Ok(prefs);
    }
    // LevelDB opens a writable log even for reads. Open an isolated snapshot.
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let label = name.to_string_lossy();
        if entry.file_type().map_err(|e| e.to_string())?.is_file()
            && (label == "CURRENT"
                || label.starts_with("MANIFEST-")
                || [".log", ".ldb", ".sst"].iter().any(|s| label.ends_with(s)))
        {
            fs::copy(entry.path(), temp.path().join(name))
                .map_err(|_| "Cannot snapshot existing dashboard preferences.")?;
        }
    }
    let mut db = DB::open(
        temp.path(),
        Options {
            create_if_missing: false,
            ..Options::default()
        },
    )
    .map_err(|_| "Cannot read existing dashboard preferences.")?;
    for name in KEYS {
        let key = format!("_file://\0\x01{name}");
        if let Some(data) = db.get(key.as_bytes()) {
            if let Some(bytes) = data.strip_prefix(&[1]) {
                if bytes.len() <= 100 && bytes.is_ascii() {
                    prefs[*name] = Value::String(String::from_utf8_lossy(bytes).into());
                }
            }
        }
    }
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_only_dashboard_preferences_from_file_origin() {
        let folder = tempfile::tempdir().unwrap();
        {
            let mut db = DB::open(folder.path(), Options::default()).unwrap();
            db.put(b"_file://\0\x01dashboard:activeTab", b"\x01clis")
                .unwrap();
            db.put(b"_file://\0\x01unrelated", b"\x01private").unwrap();
            db.put(
                b"_https://example.org\0\x01dashboard:fontPreset",
                b"\x01other",
            )
            .unwrap();
            db.flush().unwrap();
        }
        assert_eq!(
            legacy_preferences(folder.path()).unwrap(),
            json!({"dashboard:activeTab":"clis"})
        );
    }
}
