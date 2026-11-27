use tauri_plugin_global_shortcut::Shortcut;

pub struct Hotkey {
    pub accelerator: String,
    pub shortcut: Shortcut,
}

pub fn parse(name: &str) -> Result<Hotkey, String> {
    parse_for(name, cfg!(target_os = "macos"))
}

fn parse_for(name: &str, mac: bool) -> Result<Hotkey, String> {
    let invalid = "Choose a shortcut with a modifier and a final key.";
    if name.len() > 90 {
        return Err(invalid.into());
    }
    let parts: Vec<_> = name.split('+').map(str::trim).collect();
    if !(2..=4).contains(&parts.len()) {
        return Err(invalid.into());
    }
    let (key, modifiers) = parts.split_last().unwrap();
    let mut canonical = Vec::with_capacity(parts.len());
    for modifier in modifiers {
        let token = match modifier.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" | "commandorctrl" => {
                if mac {
                    "Command"
                } else {
                    "Control"
                }
            }
            "cmd" | "command" => "Command",
            "ctrl" | "control" => "Control",
            "win" | "super" | "meta" => {
                if mac {
                    "Command"
                } else {
                    "Super"
                }
            }
            "alt" | "option" => "Alt",
            "shift" => "Shift",
            _ => return Err(invalid.into()),
        };
        canonical.push(token);
    }
    // Historic settings and DOM events use several spellings absent from the native parser.
    let native_key = match key.to_ascii_lowercase().as_str() {
        "return" => "Enter",
        "del" => "Delete",
        "break" => "Pause",
        "medianexttrack" => "MediaTrackNext",
        "mediaprevioustrack" => "MediaTrackPrevious",
        "plus" | "equals" => "Equal",
        "tilde" | "~" => "Backquote",
        "\"" => "Quote",
        _ => key,
    };
    let mut native = canonical.clone();
    native.push(native_key);
    let shortcut = native.join("+").parse::<Shortcut>().map_err(|_| invalid)?;
    canonical.push(key);
    Ok(Hotkey {
        accelerator: canonical.join("+"),
        shortcut,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_modifiers_remain_distinct_and_aliases_share_a_registration() {
        let command = parse_for("Command+Shift+J", true).unwrap();
        let control = parse_for("Control+Shift+J", true).unwrap();
        assert_ne!(command.shortcut, control.shortcut);
        for alias in ["Meta", "Super", "Cmd", "CommandOrControl"] {
            let hotkey = parse_for(&format!("{alias}+Shift+J"), true).unwrap();
            assert_eq!(hotkey.shortcut, command.shortcut);
            assert_eq!(hotkey.accelerator, "Command+Shift+J");
        }
        assert_eq!(
            parse_for("Shift+Ctrl+J", true).unwrap().shortcut,
            control.shortcut
        );
        assert_eq!(
            parse_for("CommandOrControl+Shift+J", false)
                .unwrap()
                .shortcut,
            control.shortcut
        );
        assert_ne!(
            parse_for("Command+Control+Shift+J", true).unwrap().shortcut,
            command.shortcut
        );
        assert_eq!(
            parse_for("Win+Option+J", false).unwrap().accelerator,
            "Super+Alt+J"
        );
        for invalid in ["J", "Ctrl+Shift", "F1+J", "Ctrl++J", "Ctrl+J+Shift"] {
            assert!(parse_for(invalid, true).is_err());
        }
        for key in [
            "Plus",
            "Equals",
            "Return",
            "Del",
            "Break",
            "Tilde",
            "MediaNextTrack",
            "Num4",
            "F24",
        ] {
            assert!(parse_for(&format!("Control+{key}"), false).is_ok());
        }
    }
}
