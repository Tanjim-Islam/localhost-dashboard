use super::native::{Context, Result};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

// npm on Darwin may overwrite argv[0] with its process title. Only recover
// literal suffixes corroborated by the original npm child environment and argv.
pub(super) fn words(text: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut active = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if quote == Some('\'') {
            if c == '\'' {
                quote = None
            } else {
                word.push(c)
            }
            continue;
        }
        if c == '\\' {
            let next = chars.next()?;
            if next == '\n' {
                return None;
            }
            if quote == Some('"') && !['\\', '$', '\u{60}', '"'].contains(&next) {
                word.push('\\')
            }
            word.push(next);
            active = true;
            continue;
        }
        if c == '"' {
            quote = if quote.is_some() { None } else { Some(c) };
            active = true;
            continue;
        }
        if quote.is_none() && c == '\'' {
            quote = Some(c);
            active = true;
            continue;
        }
        if ['$', '\u{60}', '\n', '\r'].contains(&c)
            || (quote.is_none() && ";&|<>()[*?~{}]".contains(c))
        {
            return None;
        }
        if quote.is_none() && c.is_whitespace() {
            if active {
                words.push(std::mem::take(&mut word));
            }
            active = false;
        } else {
            word.push(c);
            active = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if active {
        words.push(word)
    }
    Some(words)
}
fn absolute(child: &Context, file: &OsStr) -> Option<PathBuf> {
    child.cwd.join(file).canonicalize().ok()
}
fn command_path(child: &Context, cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') {
        return absolute(child, cmd.as_ref());
    }
    std::env::split_paths(child.env.get(OsStr::new("PATH"))?)
        .find_map(|p| absolute(child, p.join(cmd).as_os_str()))
}
fn remaining(child: &Context, script: &str) -> Option<Vec<OsString>> {
    let shell = child.id.exe.file_name().and_then(OsStr::to_str);
    if matches!(shell, Some("sh" | "bash" | "zsh")) {
        if let Some(index) = child.argv.iter().position(|a| a == "-c") {
            let suffix = child.argv.get(index + 1)?.to_str()?.strip_prefix(script)?;
            if suffix.is_empty() || suffix.starts_with(char::is_whitespace) {
                return Some(words(suffix)?.into_iter().map(OsString::from).collect());
            }
        }
    }
    let parts = words(script)?;
    let command = command_path(child, parts.first()?)?;
    let offset = if child.id.exe.canonicalize().ok().as_ref() == Some(&command) {
        1
    } else if absolute(child, child.argv.get(1)?).as_ref() == Some(&command) {
        2
    } else {
        return None;
    };
    let args = child.argv.get(offset..)?;
    let expected = &parts[1..];
    if expected.len() > args.len() {
        return None;
    }
    for (a, b) in expected.iter().zip(args) {
        if OsStr::new(a) == b {
            continue;
        }
        let val = absolute(child, a.as_ref())?;
        if Some(val) != absolute(child, b) {
            return None;
        }
    }
    Some(args[expected.len()..].to_vec())
}
pub(super) fn recover(npm: &mut Context, children: &[Context]) -> Result<()> {
    let title = npm.argv.first().and_then(|s| s.to_str()).unwrap_or("");
    if !["npm run", "npm run-script", "npm start", "npm test"]
        .iter()
        .any(|p| title == *p || title.strip_prefix(p).is_some_and(|s| s.starts_with(' ')))
    {
        return Ok(());
    }
    for child in children {
        let get = |key: &str| child.env.get(OsStr::new(key)).and_then(|v| v.to_str());
        let (Some(cli), Some(event), Some(script), Some(manifest)) = (
            get("npm_execpath"),
            get("npm_lifecycle_event"),
            get("npm_lifecycle_script"),
            get("npm_package_json"),
        ) else {
            continue;
        };
        let manifest = Path::new(manifest);
        if event.is_empty()
            || !event
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.:@/-".contains(c))
            || !manifest.as_os_str().to_string_lossy().starts_with('/')
            || manifest.file_name() != Some(OsStr::new("package.json"))
            || !cli.starts_with('/')
        {
            continue;
        }
        let Some(extra) = remaining(child, script) else {
            continue;
        };
        let mut argv = vec![
            npm.id.exe.as_os_str().to_owned(),
            cli.into(),
            "run".into(),
            event.into(),
            "--".into(),
        ];
        argv.extend(extra);
        npm.argv = argv;
        npm.cwd = manifest.parent().unwrap().into();
        for (k, v) in &child.env {
            if k.to_string_lossy().starts_with("npm_config_") {
                npm.env.insert(k.clone(), v.clone());
            }
        }
        return Ok(());
    }
    Err("npm replaced its original arguments and they could not be recovered exactly.".into())
}
