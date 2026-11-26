use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_autostart::ManagerExt;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

#[test]
fn autostart_registers_and_removes_a_unique_real_windows_login_item() {
    let name = format!("Local Dashboard QA {}", uuid::Uuid::new_v4());
    let app = mock_builder()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(&name)
                .arg("--hidden")
                .build(),
        )
        .build(mock_context(noop_assets()))
        .unwrap();
    let launcher = app.autolaunch();
    let registry = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .unwrap();
    assert!(!launcher.is_enabled().unwrap());
    assert!(registry.get_raw_value(&name).is_err());
    struct Cleanup<'a>(&'a tauri_plugin_autostart::AutoLaunchManager);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.disable();
        }
    }
    let _cleanup = Cleanup(&launcher);
    launcher.enable().unwrap();
    assert!(launcher.is_enabled().unwrap());
    let command: String = registry.get_value(&name).unwrap();
    let executable = std::env::current_exe().unwrap();
    assert!(command.contains(executable.file_name().unwrap().to_str().unwrap()));
    assert!(command.ends_with("--hidden"));
    launcher.disable().unwrap();
    assert!(!launcher.is_enabled().unwrap());
    assert!(registry.get_raw_value(&name).is_err());
}
