use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufReader, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub fn read_json(dir: &Path, name: &str, default: Value) -> Result<Value, String> {
    match fs::File::open(dir.join(name)) {
        Ok(file) => serde_json::from_reader(BufReader::new(file))
            .map_err(|_| format!("Invalid data in {name}.")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(default),
        Err(_) => Err(format!("Cannot read {name}.")),
    }
}

pub fn write_json(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    let mut pending =
        tempfile::NamedTempFile::new_in(dir).map_err(|_| format!("Cannot create {name}."))?;
    serde_json::to_writer(pending.as_file_mut(), value)
        .map_err(|_| format!("Cannot write {name}."))?;
    pending
        .flush()
        .and_then(|_| pending.as_file().sync_all())
        .map_err(|_| format!("Cannot flush {name}."))?;
    pending
        .persist(dir.join(name))
        .map_err(|_| format!("Cannot replace {name}."))?;
    Ok(())
}

pub const STORES: &[&str] = &[
    "settings.json",
    "stats.json",
    "projects.json",
    "port-notes.json",
    "clis.json",
    "recent-scripts.json",
];

pub fn isolated() -> bool {
    std::env::var_os("LOCAL_DASHBOARD_CLIS_TEST_ROOT").is_some()
}

pub fn initialize(app: &AppHandle) -> Result<PathBuf, String> {
    let fixture = std::env::var_os("LOCAL_DASHBOARD_CLIS_TEST_ROOT").map(PathBuf::from);
    let dir = match &fixture {
        Some(p) if p.is_absolute() => p.join("tauri-app-data"),
        Some(_) => return Err("Fixture root must be absolute.".into()),
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|_| "Cannot create dashboard data directory.")?;
    if !dir.join("migration-v1.json").exists() {
        if let Some(legacy) = legacy_profile(app)? {
            import(&legacy, &dir)?;
        }
        write_json(&dir, "migration-v1.json", &json!({"version":1}))?;
    }
    Ok(dir)
}

fn legacy_profile(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let parent = app.path().config_dir().map_err(|e| e.to_string())?;
    let candidates = match std::env::var_os("LOCAL_DASHBOARD_CLIS_TEST_ROOT") {
        Some(p) => vec![PathBuf::from(p).join("electron-app-data/Electron")],
        None => vec![
            parent.join("local-dashboard"),
            parent.join("Localhost Dashboard"),
        ],
    };
    Ok(candidates.into_iter().find(|p| {
        STORES.iter().any(|f| p.join(f).is_file())
            || p.join("settings.sqlite").is_file()
            || p.join("Local Storage/leveldb/CURRENT").is_file()
    }))
}

pub fn renderer_preferences(app: &AppHandle) -> Result<Value, String> {
    let dir = &app.state::<crate::settings::Settings>().dir;
    if dir.join("renderer-preferences.json").is_file() {
        return read_json(dir, "renderer-preferences.json", json!({}));
    }
    let prefs = match legacy_profile(app)? {
        Some(p) => crate::preferences::legacy_preferences(&p.join("Local Storage/leveldb"))?,
        None => json!({}),
    };
    write_json(dir, "renderer-preferences.json", &prefs)?;
    Ok(prefs)
}

fn import(old: &Path, dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if old.join("settings.sqlite").is_file() && !dir.join("settings.json").exists() {
        use rusqlite::{Connection, OpenFlags};
        let db = Connection::open_with_flags(
            old.join("settings.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        let mut statement = db
            .prepare("SELECT key,value FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut settings = read_json(old, "settings.json", json!({}))?;
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            if let Ok(value) = serde_json::from_str::<Value>(&v) {
                settings[k] = value;
            }
        }
        write_json(dir, "settings.json", &settings)?;
    }
    for name in STORES {
        if old.join(name).is_file() && !dir.join(name).exists() {
            let value = read_json(old, name, Value::Null)?;
            write_json(dir, name, &value)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "read-only import of an existing dashboard profile into a temporary directory"]
    fn existing_profile_opens_in_all_native_subsystems() {
        let source = PathBuf::from(
            std::env::var_os("DASHBOARD_LEGACY_PROFILE").expect("Set DASHBOARD_LEGACY_PROFILE"),
        );
        assert!(source.is_absolute() && source.join("settings.json").is_file());
        let imported = tempfile::tempdir().unwrap();
        import(&source, imported.path()).unwrap();
        for name in STORES.iter().filter(|name| source.join(name).is_file()) {
            #[cfg(target_os = "macos")]
            if *name == "settings.json" && source.join("settings.sqlite").is_file() {
                continue;
            }
            // Compare without formatting either user's data or its contents on error.
            assert!(
                read_json(&source, name, Value::Null).unwrap()
                    == read_json(imported.path(), name, Value::Null).unwrap(),
                "Import changed {name}"
            );
        }
        crate::settings::Settings::new(imported.path()).unwrap();
        crate::servers::Servers::new(imported.path()).unwrap();
        crate::automation::Automation::new(imported.path()).unwrap();
        crate::clis::Clis::new(imported.path()).unwrap();
    }
    #[test]
    fn migration_is_scoped_repeatable_and_preserves_source() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        for f in ["settings.json", "projects.json", "unrelated.json"] {
            write_json(old.path(), f, &json!({"old":true})).unwrap();
        }
        import(old.path(), new.path()).unwrap();
        write_json(new.path(), "settings.json", &json!({"new":true})).unwrap();
        import(old.path(), new.path()).unwrap();
        assert_eq!(
            read_json(new.path(), "settings.json", Value::Null).unwrap(),
            json!({"new":true})
        );
        assert_eq!(
            read_json(old.path(), "settings.json", Value::Null).unwrap(),
            json!({"old":true})
        );
        assert!(!new.path().join("unrelated.json").exists());
        assert_eq!(
            read_json(new.path(), "projects.json", Value::Null).unwrap(),
            json!({"old":true})
        );
    }
    #[test]
    fn invalid_data_is_never_replaced_with_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("projects.json"), b"{").unwrap();
        assert!(read_json(dir.path(), "projects.json", json!({})).is_err());
        assert_eq!(fs::read(dir.path().join("projects.json")).unwrap(), b"{");
    }
}
