use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Error, ErrorKind};
use std::sync::{LazyLock, Mutex};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE};
use winreg::RegKey;

#[derive(Copy, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Scope {
    User,
    Machine,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Machine => "machine",
        }
    }

    fn open(self, write: bool) -> Result<RegKey, String> {
        let (hive, path) = match self {
            Self::User => (HKEY_CURRENT_USER, "Environment"),
            Self::Machine => (
                HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            ),
        };
        let flags = if write {
            KEY_QUERY_VALUE | KEY_SET_VALUE
        } else {
            KEY_QUERY_VALUE
        };
        RegKey::predef(hive)
            .open_subkey_with_flags(path, flags)
            .map_err(os_error)
    }
}

fn os_error(error: Error) -> String {
    match error.kind() {
        ErrorKind::NotFound => "Environment variable was not found.".into(),
        ErrorKind::PermissionDenied => "Windows denied access to this environment variable.".into(),
        _ => format!(
            "Windows environment operation failed ({}).",
            error.raw_os_error().unwrap_or_default()
        ),
    }
}

fn name(input: &str) -> Result<String, String> {
    let n = input.trim().to_ascii_uppercase();
    if n.len() > 128
        || n.is_empty()
        || n.as_bytes()[0].is_ascii_digit()
        || !n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(
            "Use 1 to 128 letters, numbers, or underscores and do not start with a number.".into(),
        );
    }
    if !n.split('_').any(|part| {
        matches!(
            part,
            "KEY"
                | "TOKEN"
                | "SECRET"
                | "PASSWORD"
                | "PASSWD"
                | "PWD"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "PAT"
        )
    }) {
        return Err(
            "The name must include KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, or PAT.".into(),
        );
    }
    Ok(n)
}

#[derive(Deserialize)]
struct Reference {
    name: String,
    scope: Scope,
}

impl Reference {
    fn validate(mut self) -> Result<Self, String> {
        self.name = name(&self.name)?;
        Ok(self)
    }
}

fn reference(arg: Value) -> Result<Reference, String> {
    serde_json::from_value::<Reference>(arg)
        .map_err(|_| "Invalid environment key reference.".to_string())?
        .validate()
}

fn value_at(key: &RegKey, name: &str) -> Result<Option<String>, String> {
    match key.get_value::<String, _>(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(os_error(error)),
    }
}

fn read(reference: &Reference) -> Result<String, String> {
    value_at(&reference.scope.open(false)?, &reference.name)?
        .ok_or_else(|| "Environment variable was not found.".into())
}

fn list() -> Result<Value, String> {
    let user_key = Scope::User.open(false)?;
    let mut result = Vec::new();
    for scope in [Scope::User, Scope::Machine] {
        let key = scope.open(false)?;
        let start = result.len();
        for item in key.enum_values() {
            let (raw_name, raw_value) = item.map_err(os_error)?;
            let Ok(key_name) = name(&raw_name) else {
                continue;
            };
            let Ok(stored) = <String as winreg::types::FromRegValue>::from_reg_value(&raw_value)
            else {
                continue;
            };
            let active =
                std::env::var_os(&key_name).is_some_and(|v| v == std::ffi::OsStr::new(&stored));
            let status = if active {
                "active"
            } else if scope == Scope::Machine
                && value_at(&user_key, &key_name)?.is_some_and(|v| v != stored)
            {
                "shadowed"
            } else {
                "restart-required"
            };
            result.push(json!({
                "id": format!("{}:{}", scope.label(), key_name), "name": key_name,
                "scope": scope.label(), "valueLength": stored.encode_utf16().count(),
                "sessionStatus": status
            }));
        }
        result[start..].sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    }
    Ok(Value::Array(result))
}

fn save(arg: Value) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Save {
        name: String,
        scope: Scope,
        value: String,
        original: Option<Reference>,
    }
    let Save {
        name: new_name,
        scope,
        value,
        original,
    } = serde_json::from_value(arg).map_err(|_| "Invalid environment key details.".to_string())?;
    let new_name = name(&new_name)?;
    if value.is_empty() || value.contains('\0') || value.encode_utf16().count() > 8192 {
        return Err(
            "Values must contain 1 to 8192 characters and cannot contain null characters.".into(),
        );
    }
    let dest = scope.open(true)?;
    let original = original.map(Reference::validate).transpose()?;
    if let Some(old) = &original {
        read(old)?;
        if old.scope == scope && old.name == new_name {
            return dest.set_value(&new_name, &value).map_err(os_error);
        }
    }
    if value_at(&dest, &new_name)?.is_some() {
        return Err("An environment variable with this name already exists in this scope.".into());
    }
    let source = original
        .as_ref()
        .map(|old| old.scope.open(true))
        .transpose()?;
    dest.set_value(&new_name, &value).map_err(os_error)?;
    if let Some((source, old)) = source.zip(original) {
        if let Err(error) = source.delete_value(&old.name) {
            dest.delete_value(&new_name)
                .map_err(|_| "Rename failed. Both variable names may exist.".to_string())?;
            return Err(os_error(error));
        }
    }
    Ok(())
}

fn notify_environment_changed() {
    // WM_SETTINGCHANGE is synchronous. Keep the UTF-16 payload alive through the broadcast.
    let section: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            section.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            100,
            std::ptr::null_mut(),
        );
    }
}

pub(super) fn dispatch(method: &str, arg: Value) -> Result<Value, String> {
    static ACCESS: LazyLock<Mutex<()>> = LazyLock::new(Mutex::default);
    let _lock = ACCESS
        .lock()
        .map_err(|_| "Environment key operation failed.".to_string())?;
    match method {
        "getEnvironmentKeys" => return list(),
        "getEnvironmentKeyValue" => return read(&reference(arg)?).map(Value::String),
        "saveEnvironmentKey" => save(arg)?,
        "deleteEnvironmentKey" => {
            let target = reference(arg)?;
            target
                .scope
                .open(true)?
                .delete_value(&target.name)
                .map_err(os_error)?;
        }
        _ => return Err("Unknown environment key action.".into()),
    }
    notify_environment_changed();
    list()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_secret_names_and_references() {
        assert_eq!(name(" gh_token ").unwrap(), "GH_TOKEN");
        for invalid in [
            "PATH",
            "MONKEY_MODE",
            "KEYBOARD_LAYOUT",
            "9_DHL_KEY",
            "bad-key",
            "token\0",
        ] {
            assert!(name(invalid).is_err());
        }
        assert!(reference(json!({"scope":"process","name":"TEST_KEY"})).is_err());
    }

    #[test]
    fn windows_user_key_lifecycle_and_masked_list() {
        let key = format!(
            "LOCAL_DASHBOARD_TEST_KEY_{}_{}",
            std::process::id(),
            super::super::now()
        );
        let other = format!("{key}_RENAMED");
        let user = Scope::User.open(true).unwrap();
        assert!(user.get_raw_value(&key).is_err() && user.get_raw_value(&other).is_err());
        struct Cleanup<'a>(&'a RegKey, [&'a str; 2]);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                for name in self.1 {
                    let _ = self.0.delete_value(name);
                }
            }
        }
        let _cleanup = Cleanup(&user, [&key, &other]);
        let a = json!({"scope":"user","name":key});
        let b = json!({"scope":"user","name":other});
        let first = json!({"scope":"user","name":key,"value":" synthetic ✓🦀 "});
        let listed = dispatch("saveEnvironmentKey", first.clone()).unwrap();
        let summary = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == key)
            .unwrap();
        assert_eq!(
            summary["valueLength"],
            " synthetic ✓🦀 ".encode_utf16().count()
        );
        assert_eq!(summary.as_object().unwrap().len(), 5);
        assert!(!listed.to_string().contains("synthetic"));
        assert!(dispatch("saveEnvironmentKey", first).is_err());
        assert_eq!(
            dispatch("getEnvironmentKeyValue", a.clone()).unwrap(),
            " synthetic ✓🦀 "
        );
        assert!(dispatch(
            "saveEnvironmentKey",
            json!({"scope":"user","name":key,"value":"","original":a})
        )
        .is_err());
        dispatch(
            "saveEnvironmentKey",
            json!({"scope":"user","name":key,"value":"edited","original":a}),
        )
        .unwrap();
        dispatch(
            "saveEnvironmentKey",
            json!({"scope":"user","name":other,"value":"renamed","original":a}),
        )
        .unwrap();
        assert!(dispatch("getEnvironmentKeyValue", a).is_err());
        assert_eq!(
            dispatch("getEnvironmentKeyValue", b.clone()).unwrap(),
            "renamed"
        );
        dispatch("deleteEnvironmentKey", b.clone()).unwrap();
        assert!(dispatch("getEnvironmentKeyValue", b).is_err());
    }
}
