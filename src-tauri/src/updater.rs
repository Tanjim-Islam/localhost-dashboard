use serde_json::{json, Value};
use std::sync::Mutex;
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
pub async fn dispatch(app: &AppHandle, method: &str) -> Result<Value, String> {
    let state = app.state::<Updater>();
    match method {
        "getUpdateStatus" => {
            return Ok(state
                .status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone())
        }
        "dismissUpdate" => {
            publish(app, json!({"state":"idle"}));
            return Ok(Value::Null);
        }
        _ => {}
    }
    let mut pending = state.pending.lock().await;
    let operation:Result<Value,String>= async {
        match method {
            "checkForUpdates" => {
                if pending.bytes.is_some() {
                    if let Some(u)=&pending.update {publish(app,json!({"state":"downloaded","version":u.version}));}
                    return Ok(Value::Null)
                }
                publish(app,json!({"state":"checking"}));
                if dev(){publish(app,json!({"state":"not-available","version":"dev"}));return Ok(Value::Null)}
                let key=option_env!("TAURI_UPDATER_PUBLIC_KEY").filter(|s|!s.is_empty()).ok_or("This local build has no release update signing key.")?;
                let updater=app.updater_builder().pubkey(key).timeout(std::time::Duration::from_secs(30)).build().map_err(|e|e.to_string())?;
                let update=updater.check().await.map_err(|e|e.to_string())?;
                let status=match &update {
                    Some(u)=>json!({"state":"available","version":u.version,"releaseNotes":u.body}),
                    None=>json!({"state":"not-available","version":app.package_info().version.to_string()}),
                };
                pending.update=update;
                publish(app,status);
            }
            "downloadUpdate" => {
                if dev(){return Ok(Value::Null)}
                let update=pending.update.as_ref().ok_or("Check for an update first.")?;
                let version=update.version.clone();
                let mut received=0u64;
                publish(app,json!({"state":"downloading","percent":0,"transferred":0,"total":0}));
                let bytes=update.download(|chunk,total| {
                    received+=chunk as u64;
                    let total=total.unwrap_or(0);
                    let percent=if total==0 {0.} else {(received as f64*100./total as f64).min(100.)};
                    publish(app,json!({"state":"downloading","transferred":received,"total":total,"percent":percent}));
                },||{}).await.map_err(|e|e.to_string())?;
                pending.bytes=Some(bytes);
                publish(app,json!({"state":"downloaded","version":version}));
            }
            "installUpdate" => {
                let update=pending.update.as_ref().ok_or("No update is ready to install.")?;
                let bytes=pending.bytes.as_ref().ok_or("Download the update first.")?;
                update.install(bytes).map_err(|e|e.to_string())?;
                app.restart();
            }
            _=>return Err("Unknown update action.".into()),
        }
        Ok(Value::Null)
    }.await;
    if let Err(msg) = &operation {
        publish(app, json!({"state":"error","message":msg}));
        return Ok(if method == "installUpdate" {
            json!({"success":false,"error":msg})
        } else {
            Value::Null
        });
    }
    operation
}
pub fn start(app: &AppHandle) {
    if !dev() && option_env!("TAURI_UPDATER_PUBLIC_KEY").is_some_and(|k| !k.is_empty()) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let _ = dispatch(&app, "checkForUpdates").await;
        });
    }
}
