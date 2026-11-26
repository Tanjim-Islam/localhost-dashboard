#[cfg(windows)]
mod environment;
mod launch;
#[cfg(any(target_os = "macos", test))]
mod macos;
mod processes;
mod recent;

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn kind() -> &'static str {
    if cfg!(windows) {
        "ahk"
    } else if cfg!(target_os = "macos") {
        "automator"
    } else {
        ""
    }
}

fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    value
        .lock()
        .map_err(|_| "Automation state is unavailable.".into())
}

#[derive(Clone)]
struct Record {
    item: Value,
    native_id: Option<u64>,
    executable: Option<PathBuf>,
}
impl Record {
    #[cfg(any(target_os = "macos", test))]
    fn new(item: Value) -> Self {
        Self {
            item,
            native_id: None,
            executable: None,
        }
    }
    fn key(&self) -> &str {
        self.item["key"].as_str().unwrap_or_default()
    }
    fn running(&self) -> bool {
        self.item["pid"].as_u64().is_some()
    }
    fn script_path(&self) -> Option<&Path> {
        self.item["scriptPath"].as_str().map(Path::new)
    }
    fn name(&self) -> &str {
        self.item["scriptName"]
            .as_str()
            .or(self.item["processName"].as_str())
            .unwrap_or("Script")
    }
}

struct State {
    rows: BTreeMap<String, Record>,
    recent: recent::Recent,
}

pub struct Automation {
    state: Mutex<State>,
    scanner: Mutex<processes::Scanner>,
    scanning: tokio::sync::Mutex<()>,
}

impl Automation {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        Ok(Automation {
            state: Mutex::new(State {
                rows: BTreeMap::new(),
                recent: recent::Recent::new(data_dir)?,
            }),
            scanner: Mutex::default(),
            scanning: tokio::sync::Mutex::new(()),
        })
    }
}

pub fn start(app: AppHandle) {
    if kind().is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = refresh(&app).await {
                let _ = app.emit("onScanError", err);
            }
            tokio::time::sleep(Duration::from_millis(interval(&app))).await;
        }
    });
}

fn interval(app: &AppHandle) -> u64 {
    crate::settings::snapshot(app)["scanIntervalMs"]
        .as_u64()
        .unwrap_or(5000)
        .max(2000)
}

fn reconcile(
    previous: &BTreeMap<String, Record>,
    scanned: Vec<Record>,
    time: u64,
    interval: u64,
) -> (BTreeMap<String, Record>, Vec<Record>, Vec<Record>) {
    let mut rows = BTreeMap::new();
    let mut starts = Vec::new();
    let mut stops = Vec::new();
    for mut row in scanned {
        let old = previous.get(row.key());
        let same =
            old.is_some_and(|r| r.native_id == row.native_id && r.item["pid"] == row.item["pid"]);
        if same {
            if let Some(old) = old {
                row.item["firstSeen"] = old.item["firstSeen"].clone();
            }
        } else {
            if row.running() {
                starts.push(row.clone());
            }
            if let Some(old) = old.filter(|r| r.running()) {
                stops.push(old.clone());
            }
        }
        row.item["lastSeen"] = json!(time);
        rows.insert(row.key().to_owned(), row);
    }
    for (key, row) in previous {
        if rows.contains_key(key) {
            continue;
        }
        if time.saturating_sub(row.item["lastSeen"].as_u64().unwrap_or_default()) <= 2 * interval {
            rows.insert(key.clone(), row.clone());
        } else if row.running() {
            stops.push(row.clone());
        }
    }
    (rows, starts, stops)
}

fn publish(app: &AppHandle, scanned: Vec<Record>) -> Result<(), String> {
    let state = app.state::<Automation>();
    let (items, starts, stops, updated_recent) = {
        let mut state = lock(&state.state)?;
        let (rows, starts, stops) = reconcile(&state.rows, scanned, now(), interval(app));
        let mut next = state.recent.clone();
        let mut changed = false;
        for row in &starts {
            if let Some(path) = row.script_path() {
                next.remember(kind(), path, Some(row.name()));
                changed = true;
            }
        }
        let recent = if changed {
            next.persist()?;
            state.recent = next;
            Some(state.recent.list(kind()))
        } else {
            None
        };
        let mut ordered: Vec<&Record> = rows.values().collect();
        ordered.sort_by_cached_key(|r| r.name().to_lowercase());
        let payload: Vec<Value> = ordered.into_iter().map(|r| r.item.clone()).collect();
        state.rows = rows;
        (payload, starts, stops, recent)
    };
    let _ = app.emit(
        if cfg!(windows) {
            "onAHKUpdate"
        } else {
            "onAutomatorUpdate"
        },
        items,
    );
    if let Some(recent) = updated_recent {
        let _ = app.emit("onRecentScriptsUpdate", recent);
    }
    let prefs = crate::settings::snapshot(app);
    if !crate::storage::isolated() {
        let label = if cfg!(windows) {
            "AHK Script"
        } else {
            "Automator Script"
        };
        for (rows, setting, action) in [
            (starts, "notifyOnStart", "Started"),
            (stops, "notifyOnStop", "Stopped"),
        ] {
            if prefs[setting] != false {
                for row in rows {
                    let _ = app
                        .notification()
                        .builder()
                        .title(format!("{label} {action}"))
                        .body(row.name())
                        .show();
                }
            }
        }
    }
    Ok(())
}

async fn refresh(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Automation>();
    // If a timer or another refresh is already scanning, await its publication.
    let Ok(_guard) = state.scanning.try_lock() else {
        let _guard = state.scanning.lock().await;
        return Ok(());
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Automation>();
        let rows = lock(&state.scanner)?.scan()?;
        publish(&app, rows)
    })
    .await
    .map_err(|_| "Script scan failed.".to_string())?
}

fn argument(arg: &Value) -> Result<&str, String> {
    arg.as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0') && s.len() <= 32768)
        .ok_or_else(|| "Invalid script reference.".into())
}
fn is_method_allowed(method: &str) -> bool {
    match method {
        "killAHK" | "restartAHK" | "editAHK" => cfg!(windows),
        "refreshAutomator" | "stopAutomator" | "openAutomator" | "revealAutomator" => {
            cfg!(target_os = "macos")
        }
        "refreshAutomation" | "getRecentScripts" | "startRecentScript" | "deleteRecentScript" => {
            !kind().is_empty()
        }
        _ => false,
    }
}

fn perform(app: &AppHandle, method: &str, arg: Value) -> Result<Value, String> {
    if matches!(
        method,
        "getEnvironmentKeys"
            | "getEnvironmentKeyValue"
            | "saveEnvironmentKey"
            | "deleteEnvironmentKey"
    ) {
        #[cfg(windows)]
        return environment::dispatch(method, arg);
        #[cfg(not(windows))]
        return Err("Environment key management is available on Windows only.".into());
    }
    if method == "getRecentScripts" && kind().is_empty() {
        return Ok(json!([]));
    }
    if !is_method_allowed(method) {
        return Err("This script action is unavailable on this platform.".into());
    }
    let automation = app.state::<Automation>();
    let mut state = lock(&automation.state)?;
    match method {
        "getRecentScripts" => return Ok(state.recent.list(kind())),
        "killAHK" | "stopAutomator" => {
            let pid = arg
                .as_u64()
                .filter(|&p| p > 1 && p <= u32::MAX as u64)
                .ok_or("Invalid script process.")?;
            let row = state
                .rows
                .values()
                .find(|r| r.item["pid"] == pid)
                .ok_or("Script is no longer running.")?
                .clone();
            drop(state);
            processes::stop(&row)?;
            return Ok(Value::Null);
        }
        "startRecentScript" => {
            let entry = state.recent.get(kind(), argument(&arg)?)?;
            #[cfg(windows)]
            launch::detach(launch::launch_ahk(&entry.script_path, None, false)?);
            #[cfg(target_os = "macos")]
            launch::launch_mac(&entry.script_path)?;
            let mut next = state.recent.clone();
            next.remember(kind(), &entry.script_path, None);
            next.persist()?;
            state.recent = next;
        }
        "deleteRecentScript" => {
            let mut next = state.recent.clone();
            next.remove(kind(), argument(&arg)?);
            next.persist()?;
            state.recent = next;
        }
        #[cfg(windows)]
        "editAHK" | "restartAHK" => {
            let path = Path::new(argument(&arg)?);
            let row = state
                .rows
                .values()
                .find(|r| r.script_path() == Some(path))
                .ok_or("Script is no longer listed.")?;
            if method == "editAHK" {
                return launch::edit_ahk(path).map(|_| Value::Null);
            }
            launch::detach(launch::launch_ahk(path, row.executable.as_deref(), true)?);
            let mut next = state.recent.clone();
            next.remember(kind(), path, None);
            next.persist()?;
            state.recent = next;
        }
        #[cfg(target_os = "macos")]
        "openAutomator" | "revealAutomator" => {
            let path = Path::new(argument(&arg)?);
            let reveal = method == "revealAutomator";
            let allowed = state.rows.values().any(|r| {
                (r.script_path() == Some(path) && (reveal || r.item["canOpenInAutomator"] == true))
                    || (reveal && r.item["processPath"].as_str().map(Path::new) == Some(path))
            });
            if !allowed {
                return Err("Script is no longer listed.".into());
            }
            return launch::open_mac(path, reveal).map(|_| Value::Null);
        }
        _ => return Err("Unknown automation action.".into()),
    }
    let recent = state.recent.list(kind());
    drop(state);
    let _ = app.emit("onRecentScriptsUpdate", &recent);
    if method == "restartAHK" {
        Ok(Value::Null)
    } else {
        Ok(recent)
    }
}

pub async fn dispatch(app: AppHandle, method: &str, arg: Value) -> Result<Value, String> {
    if method == "refreshAutomation" || method == "refreshAutomator" {
        if !kind().is_empty() && (method == "refreshAutomation" || cfg!(target_os = "macos")) {
            refresh(&app).await?;
        }
        return Ok(Value::Null);
    }
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || perform(&app, &method, arg))
        .await
        .map_err(|_| "Automation operation failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(stamp: u64) -> Record {
        let mut row = Record::new(json!({"key":"20","pid":20,"firstSeen":100,"lastSeen":100}));
        row.native_id = Some(stamp);
        row
    }
    #[test]
    fn stable_instances_keep_start_time_and_transient_absence() {
        let (first, starts, stops) = reconcile(&BTreeMap::new(), vec![row(1)], 100, 10);
        assert_eq!((starts.len(), stops.len()), (1, 0));
        let (same, starts, stops) = reconcile(&first, vec![row(1)], 110, 10);
        assert_eq!(same["20"].item["firstSeen"], 100);
        assert!(starts.is_empty() && stops.is_empty());
        assert_eq!(reconcile(&same, vec![], 130, 10).0.len(), 1);
        assert_eq!(reconcile(&same, vec![], 131, 10).2.len(), 1);
        let (_, starts, stops) = reconcile(&same, vec![row(2)], 120, 10);
        assert_eq!((starts.len(), stops.len()), (1, 1));
    }
}
