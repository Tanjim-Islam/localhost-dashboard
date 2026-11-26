use tauri::test::{mock_builder, mock_context, noop_assets};

#[test]
fn clipboard_and_hotkeys_use_a_private_windows_desktop() {
    const WORKER: &str = "LOCAL_DASHBOARD_TEST_PRIVATE_DESKTOP_WORKER";
    if std::env::var_os(WORKER).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shell_checks::clipboard_and_hotkeys_use_a_private_windows_desktop",
                "--nocapture",
            ])
            .env(WORKER, "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Private desktop worker failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    use std::ptr::{null, null_mut};
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_ALL},
        Security::{
            ImpersonateLoggedOnUser, LogonUserW, RevertToSelf, LOGON32_LOGON_NEW_CREDENTIALS,
            LOGON32_PROVIDER_WINNT50,
        },
        System::{StationsAndDesktops::*, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::CWF_CREATE_ONLY,
    };
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let desktop_name = wide("Fixture");
    // Use a separate process because a window station owns the process-wide clipboard.
    // A failed isolation check aborts before any clipboard API is called.
    unsafe {
        let original_station = GetProcessWindowStation();
        let original_desktop = GetThreadDesktop(GetCurrentThreadId());
        // A fresh network-only logon ID gives an ordinary Windows user a unique unnamed
        // station. The placeholder credentials are never used for network access.
        let mut token = null_mut();
        assert_ne!(
            LogonUserW(
                wide("LocalDashboardOfflineTest").as_ptr(),
                wide(".").as_ptr(),
                wide(&uuid::Uuid::new_v4().to_string()).as_ptr(),
                LOGON32_LOGON_NEW_CREDENTIALS,
                LOGON32_PROVIDER_WINNT50,
                &mut token
            ),
            0,
            "Create offline logon: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(ImpersonateLoggedOnUser(token), 0);
        let station = CreateWindowStationW(null(), CWF_CREATE_ONLY, GENERIC_ALL, null());
        let station_error = std::io::Error::last_os_error();
        assert_ne!(RevertToSelf(), 0);
        CloseHandle(token);
        assert!(
            !station.is_null(),
            "Create private window station: {station_error}"
        );
        assert_ne!(SetProcessWindowStation(station), 0);
        let desktop = CreateDesktopW(
            desktop_name.as_ptr(),
            null(),
            null(),
            0,
            GENERIC_ALL,
            null(),
        );
        assert!(
            !desktop.is_null(),
            "Create private desktop: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(SetThreadDesktop(desktop), 0);
        let mut current = [0u16; 128];
        assert_ne!(
            GetUserObjectInformationW(
                GetProcessWindowStation(),
                UOI_NAME,
                current.as_mut_ptr().cast(),
                std::mem::size_of_val(&current) as u32,
                null_mut()
            ),
            0
        );
        let len = current.iter().position(|&c| c == 0).unwrap();
        assert!(String::from_utf16_lossy(&current[..len]).starts_with("Service-"));
        let app = mock_builder()
            .plugin(tauri_plugin_clipboard_manager::init())
            .build(mock_context(noop_assets()))
            .unwrap();
        let marker = format!("Dashboard clipboard 🦀 {}", uuid::Uuid::new_v4());
        app.clipboard().write_text(marker.clone()).unwrap();
        assert_eq!(app.clipboard().read_text().unwrap(), marker);
        drop(app);
        assert_ne!(SetThreadDesktop(original_desktop), 0);
        assert_ne!(SetProcessWindowStation(original_station), 0);
        CloseDesktop(desktop);
        CloseWindowStation(station);

        // Windows registers hotkeys only on an interactive station. A fresh, never
        // activated desktop isolates both registrations from the user's input desktop.
        let name = wide(&format!("DashboardHotkey{}", uuid::Uuid::new_v4().simple()));
        let test_desktop = CreateDesktopW(name.as_ptr(), null(), null(), 0, GENERIC_ALL, null());
        assert!(
            !test_desktop.is_null(),
            "Create hotkey desktop: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(SetThreadDesktop(test_desktop), 0);
    }
    {
        let app = mock_builder()
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let competing_app = mock_builder()
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        for binding in ["Ctrl+Alt+Shift+F23", "Ctrl+Alt+Shift+F24"] {
            app.global_shortcut().register(binding).unwrap();
            assert!(competing_app.global_shortcut().register(binding).is_err());
            app.global_shortcut().unregister(binding).unwrap();
            competing_app.global_shortcut().register(binding).unwrap();
            competing_app.global_shortcut().unregister(binding).unwrap();
        }
    }
    // The isolated worker exits here. Windows closes its desktop, station, and native windows.
}
