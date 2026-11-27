use crate::settings;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn show(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(false);
}
pub fn is_foreground(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        if !window.is_visible().unwrap_or(false) {
            return false;
        }
        // WebView2 can hold keyboard focus in a child HWND. Windows still reports
        // the dashboard's top-level HWND as the foreground window.
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            window
                .hwnd()
                .is_ok_and(|hwnd| hwnd.0 == unsafe { GetForegroundWindow() })
        }
        #[cfg(not(windows))]
        {
            window.is_focused().unwrap_or(false)
        }
    })
}
pub fn sync_tray(app: &AppHandle, enabled: bool) {
    if let Some(check) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
        let _ = check.set_checked(enabled);
    }
}
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    if cfg!(target_os = "macos") {
        let about = PredefinedMenuItem::about(app, Some("About Localhost Dashboard"), None)?;
        let hide = PredefinedMenuItem::hide(app, Some("Hide Localhost Dashboard"))?;
        let others = PredefinedMenuItem::hide_others(app, None)?;
        let show = PredefinedMenuItem::show_all(app, None)?;
        let quit = PredefinedMenuItem::quit(app, Some("Quit Localhost Dashboard"))?;
        let first = PredefinedMenuItem::separator(app)?;
        let last = PredefinedMenuItem::separator(app)?;
        let application = tauri::menu::Submenu::with_items(
            app,
            "Localhost Dashboard",
            true,
            &[&about, &first, &hide, &others, &show, &last, &quit],
        )?;
        app.set_menu(Menu::with_items(app, &[&application])?)?;
        return Ok(());
    }
    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Start at Login",
        true,
        settings::snapshot(app)["startAtLogin"] == true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &refresh, &login, &sep2, &quit])?;
    app.manage(login);
    TrayIconBuilder::with_id("dashboard")
        .icon(app.default_window_icon().expect("bundled app icon").clone())
        .tooltip("Localhost Dashboard")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            "refresh" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::refresh(h).await;
                });
            }
            "login" => {
                let enabled = settings::snapshot(app)["startAtLogin"] == true;
                if let Err(e) =
                    settings::update(app, Some(serde_json::json!({"startAtLogin":!enabled})))
                {
                    sync_tray(app, enabled);
                    eprintln!("{e}");
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
