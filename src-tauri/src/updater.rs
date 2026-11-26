use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}
pub struct Updater {
    status: Mutex<Value>,
    pending: tokio::sync::Mutex<Pending>,
}
impl Default for Updater {
    fn default() -> Self {
        Self {
            status: Mutex::new(json!({"state":"idle"})),
            pending: Default::default(),
        }
    }
}
fn publish(app: &AppHandle, value: Value) {
    *app.state::<Updater>()
        .status
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = value.clone();
    let _ = app.emit("onUpdateStatus", &value);
}
fn dev() -> bool {
    cfg!(debug_assertions) || crate::storage::isolated()
}

pub(crate) async fn check<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .pubkey(key)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

pub(crate) async fn download(
    update: &Update,
    mut notify: impl FnMut(Value),
) -> Result<Vec<u8>, String> {
    let mut received = 0u64;
    let mut previous = Instant::now();
    notify(json!({"state":"downloading","percent":0,"transferred":0,"total":0}));
    let bytes=update.download(|chunk,total|{
        received+=chunk as u64;
        let total=total.unwrap_or(0);
        if previous.elapsed()>=Duration::from_millis(100) || received==total {
            let percent=if total==0 {0.}else{(received as f64*100./total as f64).min(100.)};
            notify(json!({"state":"downloading","transferred":received,"total":total,"percent":percent}));
            previous=Instant::now();
        }
    },||{}).await.map_err(|e|e.to_string())?;
    notify(json!({"state":"downloaded","version":update.version}));
    Ok(bytes)
}

impl Pending {
    async fn check(&mut self, app: &AppHandle) -> Result<(), String> {
        if let (Some(update), Some(_)) = (&self.update, &self.bytes) {
            publish(app, json!({"state":"downloaded","version":update.version}));
            return Ok(());
        }
        publish(app, json!({"state":"checking"}));
        if dev() {
            publish(app, json!({"state":"not-available","version":"dev"}));
            return Ok(());
        }
        self.update = None;
        let key = option_env!("TAURI_UPDATER_PUBLIC_KEY")
            .filter(|s| !s.is_empty())
            .ok_or("This local build has no release update signing key.")?;
        self.update = check(app, key).await?;
        if let Some(u) = &self.update {
            publish(
                app,
                json!({"state":"available","version":u.version,"releaseNotes":u.body}),
            );
            if cfg!(target_os = "macos") {
                self.fetch(app).await?;
            }
        } else {
            publish(
                app,
                json!({"state":"not-available","version":app.package_info().version.to_string()}),
            );
        }
        Ok(())
    }
    async fn fetch(&mut self, app: &AppHandle) -> Result<(), String> {
        if dev() || self.bytes.is_some() {
            return Ok(());
        }
        let update = self.update.as_ref().ok_or("Check for an update first.")?;
        self.bytes = Some(download(update, |s| publish(app, s)).await?);
        Ok(())
    }
    fn install(&mut self, app: &AppHandle) -> Result<(), String> {
        let update = self
            .update
            .as_ref()
            .ok_or("No update is ready to install.")?;
        let bytes = self.bytes.as_ref().ok_or("Download the update first.")?;
        crate::servers::flush(app);
        update.install(bytes).map_err(|e| e.to_string())?;
        self.bytes = None;
        self.update = None;
        Ok(())
    }
}

pub async fn dispatch(app: &AppHandle, method: &str) -> Result<Value, String> {
    let state = app.state::<Updater>();
    if method == "getUpdateStatus" {
        return Ok(state
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone());
    }
    if method == "dismissUpdate" {
        publish(app, json!({"state":"idle"}));
        return Ok(Value::Null);
    }
    let mut pending = state.pending.lock().await;
    let result = match method {
        "checkForUpdates" => pending.check(app).await,
        "downloadUpdate" => pending.fetch(app).await,
        "installUpdate" => pending.install(app),
        _ => return Err("Unknown update action.".into()),
    };
    if let Err(message) = result {
        publish(app, json!({"state":"error","message":message}));
        return Ok(if method == "installUpdate" {
            json!({"success":false,"error":message})
        } else {
            Value::Null
        });
    }
    drop(pending);
    if method == "installUpdate" {
        app.restart();
    }
    Ok(Value::Null)
}
pub fn finish(app: &AppHandle) {
    if let Some(state) = app.try_state::<Updater>() {
        if let Ok(mut pending) = state.pending.try_lock() {
            if pending.bytes.is_some() {
                if let Err(e) = pending.install(app) {
                    eprintln!("Update installation failed: {e}");
                }
            }
        }
    }
}
pub fn start(app: &AppHandle) {
    if dev() || option_env!("TAURI_UPDATER_PUBLIC_KEY").is_none_or(str::is_empty) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let _ = dispatch(&app, "checkForUpdates").await;
            if !cfg!(target_os = "macos") {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}
