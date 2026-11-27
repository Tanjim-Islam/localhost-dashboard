use crate::hotkey;
use crate::storage::{isolated, read_json, write_json};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(windows))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct Settings {
    pub dir: PathBuf,
    inner: Mutex<Value>,
    writer: Mutex<()>,
    recording: AtomicBool,
}

fn defaults() -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("../../resources/default-settings.json"))
            .expect("valid bundled defaults");
    value["globalHotkey"] = json!(if cfg!(target_os = "macos") {
        "Command+Shift+D"
    } else if cfg!(windows) {
        "Control+Alt+Shift+D"
    } else {
        "Ctrl+Shift+D"
    });
    value["__platformHotkeyDefaultsMigrated"] = json!(true);
    value
}

pub fn set_recording(app: &AppHandle, recording: bool) {
    app.state::<Settings>()
        .recording
        .store(recording, Ordering::Release);
}
fn merged(mut base: Value, patch: &Value) -> Result<Value, String> {
    let incoming = patch.as_object().ok_or("Invalid settings.")?;
    for (key, value) in incoming {
        match key.as_str() {
            "notifyOnStart" | "notifyOnStop" | "startAtLogin" | "openInTrayAtLogin"
            | "closeToTray" => {
                base[key] = json!(value.as_bool().ok_or("Invalid settings switch.")?);
            }
            "scanIntervalMs" => {
                base[key] = json!(value.as_u64().ok_or("Invalid scan interval.")?.max(2000))
            }
            "globalHotkey" => {
                base[key] = json!(
                    hotkey::parse(value.as_str().ok_or("Invalid global hotkey.")?)?.accelerator
                );
            }
            _ => {}
        }
    }
    Ok(base)
}
fn migrate(stored: &Value) -> Value {
    let mut out = defaults();
    if let Some(fields) = stored.as_object() {
        for (key, value) in fields {
            if key == "ports" && value.is_array() {
                out[key] = value.clone();
            } else if let Ok(next) = merged(out.clone(), &json!({key:value})) {
                out = next;
            }
        }
    }
    if stored["__legacyNotificationsMigrated"] != true {
        if let Some(v) = stored["notifications"].as_bool() {
            out["notifyOnStart"] = json!(v);
            out["notifyOnStop"] = json!(v);
        }
    }
    if stored["__platformHotkeyDefaultsMigrated"] != true
        && matches!(
            stored["globalHotkey"].as_str(),
            Some(
                "Ctrl+Shift+D"
                    | "Control+Shift+D"
                    | "CommandOrControl+Shift+D"
                    | "Control+Alt+Shift+D"
            )
        )
    {
        out["globalHotkey"] = defaults()["globalHotkey"].clone();
    }
    out
}
impl Settings {
    pub fn new(dir: &Path) -> Result<Self, String> {
        let stored = read_json(dir, "settings.json", Value::Null)?;
        let current = migrate(&stored);
        if stored != current {
            write_json(dir, "settings.json", &current)?;
        }
        Ok(Self {
            dir: dir.to_owned(),
            inner: Mutex::new(current),
            writer: Mutex::default(),
            recording: AtomicBool::default(),
        })
    }
}
pub fn snapshot(app: &AppHandle) -> Value {
    app.state::<Settings>()
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
fn register(app: &AppHandle, name: &str) -> Result<(), String> {
    let binding = hotkey::parse(name)?;
    if isolated() {
        return Ok(());
    }
    app.global_shortcut()
        .on_shortcut(binding.shortcut, move |app, _, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if !crate::window::is_foreground(app) {
                crate::window::show(app);
            } else if app.state::<Settings>().recording.load(Ordering::Acquire) {
                let _ = app.emit_to("main", "onRecordGlobalHotkey", &binding.accelerator);
            } else {
                crate::window::hide(app);
            }
        })
        .map_err(|_| "This shortcut is unavailable. Choose another combination.".into())
}
fn unregister(app: &AppHandle, name: &str) {
    if !isolated() {
        if let Ok(binding) = hotkey::parse(name) {
            let _ = app.global_shortcut().unregister(binding.shortcut);
        }
    }
}
fn login(_app: &AppHandle, enabled: bool, _explicit: bool) -> Result<(), String> {
    if cfg!(debug_assertions) || isolated() {
        return Ok(());
    }
    #[cfg(windows)]
    let result = crate::windows_login::sync(enabled, _explicit);
    #[cfg(not(windows))]
    let result = {
        let manager = _app.autolaunch();
        if enabled {
            manager.enable()
        } else if manager.is_enabled().map_err(|e| e.to_string())? {
            manager.disable()
        } else {
            Ok(())
        }
    };
    result.map_err(|_| "Could not update the login item.".into())
}
pub fn activate(app: &AppHandle) {
    let prefs = snapshot(app);
    if let Err(e) = register(app, prefs["globalHotkey"].as_str().unwrap_or_default()) {
        eprintln!("{e}");
    }
    if let Err(e) = login(app, prefs["startAtLogin"] == true, false) {
        eprintln!("{e}");
    }
}
pub fn update(app: &AppHandle, patch: Option<Value>) -> Result<Value, String> {
    let state = app.state::<Settings>();
    let _serial = state.writer.lock().map_err(|_| "Settings unavailable.")?;
    let old = snapshot(app);
    let requested_hotkey = patch
        .as_ref()
        .is_none_or(|p| p.get("globalHotkey").is_some());
    let next = match patch {
        Some(p) => merged(old.clone(), &p)?,
        None => defaults(),
    };
    let before = old["globalHotkey"]
        .as_str()
        .ok_or("Invalid stored shortcut.")?;
    let after = next["globalHotkey"].as_str().ok_or("Invalid shortcut.")?;
    let candidate = hotkey::parse(after)?.shortcut;
    let changed = hotkey::parse(before)?.shortcut != candidate;
    let register_candidate = changed
        || (requested_hotkey && !isolated() && !app.global_shortcut().is_registered(candidate));
    if register_candidate {
        register(app, after)?;
    }
    let login_changed = next["startAtLogin"] != old["startAtLogin"];
    let save = (|| {
        if login_changed {
            login(app, next["startAtLogin"] == true, true)?;
        }
        write_json(&state.dir, "settings.json", &next)
    })();
    if let Err(err) = save {
        if register_candidate {
            unregister(app, after);
        }
        if login_changed {
            let _ = login(app, old["startAtLogin"] == true, false);
        }
        return Err(err);
    }
    if changed {
        unregister(app, before);
    }
    *state.inner.lock().map_err(|_| "Settings unavailable.")? = next.clone();
    let _ = app.emit("onSettingsUpdate", &next);
    crate::window::sync_tray(app, next["startAtLogin"] == true);
    Ok(next)
}
pub fn start_hidden(prefs: &Value, login_arg: bool) -> bool {
    login_arg && prefs["startAtLogin"] == true && prefs["openInTrayAtLogin"] == true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_migration_preserves_subsequent_user_choices() {
        let legacy = json!({"globalHotkey":"Control+Shift+D"});
        let mut migrated = migrate(&legacy);
        assert_eq!(migrated["globalHotkey"], defaults()["globalHotkey"]);
        assert_eq!(migrated["__platformHotkeyDefaultsMigrated"], true);
        migrated["globalHotkey"] = json!("Ctrl+Shift+D");
        assert_eq!(migrate(&migrated)["globalHotkey"], "Control+Shift+D");
    }
    #[test]
    fn validates_updates_before_persisting() {
        let original = defaults();
        assert!(merged(
            original.clone(),
            &json!({"closeToTray":false,"globalHotkey":"Z"})
        )
        .is_err());
        assert!(merged(original.clone(), &json!({"notifyOnStart":1})).is_err());
        assert_eq!(
            merged(original, &json!({"scanIntervalMs":1,"scanAllPorts":false})).unwrap()
                ["scanIntervalMs"],
            2000
        );
    }
    #[test]
    fn migrates_legacy_and_reads_settings_after_restart() {
        let d = tempfile::tempdir().unwrap();
        write_json(d.path(),"settings.json",&json!({"notifications":false,"ports":[22],"scanAllPorts":false,"globalHotkey":"Control+Alt+B"})).unwrap();
        for _ in 0..2 {
            let value = Settings::new(d.path()).unwrap().inner.into_inner().unwrap();
            assert_eq!(value["notifyOnStop"], false);
            assert_eq!(value["scanAllPorts"], true);
            assert_eq!(value["ports"], json!([22]));
            assert_eq!(value["globalHotkey"], "Control+Alt+B");
        }
    }
    #[test]
    fn only_login_launches_can_start_hidden() {
        for enabled in [true, false] {
            for tray in [true, false] {
                for flag in [true, false] {
                    assert_eq!(
                        start_hidden(
                            &json!({"startAtLogin":enabled,"openInTrayAtLogin":tray}),
                            flag
                        ),
                        enabled && tray && flag
                    );
                }
            }
        }
    }
}
