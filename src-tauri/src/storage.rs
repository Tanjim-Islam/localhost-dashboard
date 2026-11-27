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

#[cfg(target_os = "macos")]
pub fn fixture_webview_id(dir: &Path) -> io::Result<[u8; 16]> {
    // WKWebView identifies persistent stores by UUID. Keep it with the fixture
    // so relaunches reuse it and recreating the fixture starts a fresh store.
    let path = dir.join("webview-id");
    if !path.exists() {
        let mut pending = tempfile::NamedTempFile::new_in(dir)?;
        pending.write_all(uuid::Uuid::new_v4().as_bytes())?;
        match pending.persist_noclobber(&path) {
            Ok(_) => (),
            Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.error),
        }
    }
    fs::read(path)?.try_into().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid fixture webview identifier",
        )
    })
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

#[cfg(any(target_os = "macos", test))]
fn sqlite_settings(path: &Path) -> rusqlite::Result<Value> {
    use rusqlite::{Connection, OpenFlags};
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = db.prepare("SELECT key,value FROM settings")?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut settings = json!({});
    for row in rows {
        let (key, raw) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            settings[key] = value;
        }
    }
    Ok(settings)
}

#[cfg(any(target_os = "macos", test))]
fn import_macos_settings(old: &Path, dir: &Path) -> Result<(), String> {
    let database = old.join("settings.sqlite");
    if !database.is_file() || dir.join("settings.json").exists() {
        return Ok(());
    }
    let settings = match sqlite_settings(&database) {
        Ok(settings) => settings,
        // The previous Mac build used the JSON store if SQLite was unavailable.
        Err(_) if old.join("settings.json").is_file() => {
            read_json(old, "settings.json", Value::Null)?
        }
        Err(_) => return Err("Cannot read the previous settings.sqlite database.".into()),
    };
    write_json(dir, "settings.json", &settings)
}

fn import(old: &Path, dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        import_macos_settings(old, dir)?;
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
    fn imports_the_previous_mac_sqlite_store_and_its_json_fallback() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let db_path = old.path().join("settings.sqlite");
        {
            let db = rusqlite::Connection::open(&db_path).unwrap();
            db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
                INSERT INTO settings VALUES ('scanIntervalMs','2100',1), ('notifyOnStop','false',1);").unwrap();
        }
        let bytes = fs::read(&db_path).unwrap();
        let fallback = json!({"scanIntervalMs": 4000, "closeToTray": true});
        write_json(old.path(), "settings.json", &fallback).unwrap();
        import_macos_settings(old.path(), new.path()).unwrap();
        let original = json!({"scanIntervalMs":2100,"notifyOnStop":false});
        assert_eq!(
            read_json(new.path(), "settings.json", Value::Null).unwrap(),
            original
        );
        assert_eq!(fs::read(&db_path).unwrap(), bytes);
        fs::write(&db_path, b"damaged legacy database").unwrap();
        import_macos_settings(old.path(), new.path()).unwrap();
        assert_eq!(
            read_json(new.path(), "settings.json", Value::Null).unwrap(),
            original
        );
        let fresh = tempfile::tempdir().unwrap();
        import_macos_settings(old.path(), fresh.path()).unwrap();
        assert_eq!(
            read_json(fresh.path(), "settings.json", Value::Null).unwrap(),
            fallback
        );
        fs::remove_file(old.path().join("settings.json")).unwrap();
        let empty = tempfile::tempdir().unwrap();
        assert!(import_macos_settings(old.path(), empty.path()).is_err());
        assert!(!empty.path().join("settings.json").exists());
    }
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
