use std::{ffi::OsString, io, path::Path};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
    RegKey,
};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
// Electron and its earlier auto-launch registration used this exact per-user name.
const APP_NAME: &str = "Localhost Dashboard";

fn remove_value(root: &RegKey, subkey: &str, name: &str) -> io::Result<()> {
    match root
        .open_subkey_with_flags(subkey, KEY_SET_VALUE)
        .and_then(|key| key.delete_value(name))
    {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn configure(name: &str, executable: &Path, enabled: bool, explicit: bool) -> io::Result<()> {
    let user = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        let mut command = OsString::from("\"");
        command.push(executable);
        command.push("\" --hidden");
        user.create_subkey_with_flags(RUN, KEY_SET_VALUE)?
            .0
            .set_value(name, &command)?;
    } else {
        remove_value(&user, RUN, name)?;
    }
    if explicit {
        // A manual change in Settings supersedes a Task Manager override. Starting
        // the app normally preserves any override the user made outside the app.
        remove_value(&user, APPROVED, name)?;
    }
    Ok(())
}

pub fn sync(enabled: bool, explicit: bool) -> io::Result<()> {
    configure(APP_NAME, &std::env::current_exe()?, enabled, explicit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use winreg::enums::HKEY_LOCAL_MACHINE;

    #[test]
    fn upgrades_or_removes_the_old_user_login_item_even_when_elevated() {
        let name = format!("Dashboard QA {}", uuid::Uuid::new_v4());
        let run = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN)
            .unwrap()
            .0;
        let machine = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(RUN).unwrap();
        let overrides = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(APPROVED)
            .unwrap()
            .0;
        struct Cleanup<'a>(&'a RegKey, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete_value(self.1);
            }
        }
        let _cleanup = Cleanup(&run, &name);
        let _override_cleanup = Cleanup(&overrides, &name);
        assert!(run.get_raw_value(&name).is_err());
        assert!(machine.get_raw_value(&name).is_err());
        run.set_value(&name, &r#""C:\Old App\Localhost Dashboard.exe" --hidden"#)
            .unwrap();
        let disabled = winreg::RegValue {
            vtype: winreg::enums::REG_BINARY,
            bytes: vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        overrides.set_raw_value(&name, &disabled).unwrap();
        let native = Path::new(r"C:\Fixture Space\Démo\local-dashboard.exe");
        configure(&name, native, true, false).unwrap();
        let command: String = run.get_value(&name).unwrap();
        assert_eq!(
            command,
            r#""C:\Fixture Space\Démo\local-dashboard.exe" --hidden"#
        );
        assert!(machine.get_raw_value(&name).is_err());
        assert_eq!(
            overrides.get_raw_value(&name).unwrap().bytes,
            disabled.bytes
        );
        configure(&name, native, true, true).unwrap();
        assert_eq!(
            overrides.get_raw_value(&name).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        configure(&name, native, false, true).unwrap();
        configure(&name, native, false, false).unwrap();
        assert_eq!(
            run.get_raw_value(&name).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(machine.get_raw_value(&name).is_err());
    }
}
