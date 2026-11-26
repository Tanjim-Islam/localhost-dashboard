#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod automation;
mod clis;
mod preferences;
mod servers;
mod settings;
mod storage;
mod updater;
mod window;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

async fn refresh(app: AppHandle) -> Result<Value, String> {
    let (servers, scripts) = tokio::join!(
        servers::dispatch(app.clone(), "refresh", Value::Null),
        automation::dispatch(app, "refreshAutomation", Value::Null)
    );
    servers?;
    scripts?;
    Ok(Value::Null)
}

fn local_origin(url: &url::Url) -> bool {
    let host = url.host_str();
    matches!(
        (url.scheme(), host, url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    ) || (tauri::is_dev()
        && url.scheme() == "http"
        && matches!(host, Some("localhost" | "127.0.0.1"))
        && url.port() == Some(1420))
}
#[tauri::command]
async fn dashboard(
    window: WebviewWindow,
    app: AppHandle,
    method: String,
    arg: Value,
) -> Result<Value, String> {
    if window.label() != "main"
        || !local_origin(&window.url().map_err(|_| "Invalid dashboard window.")?)
    {
        return Err("This action requires the dashboard window.".into());
    }
    match method.as_str() {
        "getMeta" => Ok(json!({
            "version":app.package_info().version.to_string(),
            "platform":if cfg!(windows) {"win32"} else if cfg!(target_os="macos") {"darwin"} else {"linux"},
            "arch":match std::env::consts::ARCH {"x86_64"=>"x64","aarch64"=>"arm64","x86"=>"ia32",other=>other},
            "features":{"servers":true,"ahkScripts":cfg!(windows),"automatorScripts":cfg!(target_os="macos"),"environmentKeys":cfg!(windows),"clis":cfg!(any(windows,target_os="macos"))},
            "clisTestMode":storage::isolated()
        })),
        "getSettings" => Ok(settings::snapshot(&app)),
        "getRendererPreferences" => storage::read_json(
            &app.state::<settings::Settings>().dir,
            "renderer-preferences.json",
            json!({}),
        ),
        "updateSettings" => settings::update(&app, Some(arg)),
        "resetSettings" => settings::update(&app, None),
        "toggleSettings" => {
            app.emit("onToggleSettings", ())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "copyText" => {
            app.clipboard()
                .write_text(arg.as_str().ok_or("Clipboard text required.")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openExplorer" => {
            let file = std::path::Path::new(arg.as_str().ok_or("Absolute path required.")?);
            if !file.is_absolute() || !file.exists() {
                return Err("Item no longer exists.".into());
            }
            app.opener()
                .reveal_item_in_dir(file)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "refresh" => refresh(app).await,
        "getUpdateStatus" | "checkForUpdates" | "downloadUpdate" | "installUpdate"
        | "dismissUpdate" => updater::dispatch(&app, &method).await,
        "getServers"
        | "getProjects"
        | "getStats"
        | "editProject"
        | "associateService"
        | "attachLegacyNote"
        | "openProjectFolder"
        | "openUrl"
        | "openTerminal"
        | "openInVSCode"
        | "stopServers"
        | "startServers"
        | "restartServer"
        | "getServerRestartState" => servers::dispatch(app, &method, arg).await,
        "getEnvironmentKeys"
        | "getEnvironmentKeyValue"
        | "saveEnvironmentKey"
        | "deleteEnvironmentKey"
        | "getRecentScripts"
        | "deleteRecentScript"
        | "startRecentScript"
        | "restartAHK"
        | "killAHK"
        | "editAHK"
        | "refreshAutomator"
        | "stopAutomator"
        | "openAutomator"
        | "revealAutomator" => automation::dispatch(app, &method, arg).await,
        "getCliInventory"
        | "getCliScanDirectories"
        | "chooseCliScanDirectory"
        | "removeCliScanDirectory"
        | "startCliScan"
        | "cancelCliScan"
        | "getCliScanState"
        | "verifyCliInstallation"
        | "setCliInstallationIncluded"
        | "revealCliInstallation"
        | "getCliUninstallPreview"
        | "uninstallCliInstallation" => clis::dispatch(app, &method, arg).await,
        _ => Err("Unknown dashboard action.".into()),
    }
}
fn main() {
    let mut builder = tauri::Builder::default();
    if !storage::isolated() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            window::show(app)
        }));
    }
    let login = tauri_plugin_autostart::Builder::new()
        .app_name("Localhost Dashboard").arg("--hidden");
    #[cfg(target_os = "macos")]
    let login = login.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder
        .plugin(login.build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![dashboard])
        .setup(|app| {
            let dir = storage::initialize(app.handle())?;
            app.manage(settings::Settings::new(&dir)?);
            app.manage(servers::Servers::new(&dir)?);
            app.manage(automation::Automation::new(&dir)?);
            app.manage(clis::Clis::new(&dir)?);
            app.manage(updater::Updater::default());
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("Missing main window.")?;
            let mut webview = tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(local_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if storage::isolated() {
                webview = webview.data_directory(dir.join("webview"));
            }
            let _window = webview.build()?;
            window::tray(app.handle())?;
            settings::activate(app.handle());
            if settings::start_hidden(
                &settings::snapshot(app.handle()),
                std::env::args_os().any(|a| a == "--hidden"),
            ) {
                window::hide(app.handle());
            } else {
                window::show(app.handle());
            }
            servers::start(app.handle().clone());
            automation::start(app.handle().clone());
            updater::start(app.handle());
            Ok(())
        })
        .on_window_event(|w, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if settings::snapshot(w.app_handle())["closeToTray"] == true {
                    api.prevent_close();
                    window::hide(w.app_handle());
                } else {
                    w.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Initialize Localhost Dashboard")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => servers::flush(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => window::show(app),
            _ => {}
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_navigation_and_native_command_origin() {
        for s in ["http://tauri.localhost/", "tauri://localhost/"] {
            assert!(local_origin(&s.parse().unwrap()));
        }
        for s in [
            "https://example.com",
            "https://tauri.localhost.attacker.example",
            "http://localhost:80",
            "file:///C:/temp/index.html",
            "http://tauri.localhost:5555",
        ] {
            assert!(!local_origin(&s.parse().unwrap()));
        }
    }
}
