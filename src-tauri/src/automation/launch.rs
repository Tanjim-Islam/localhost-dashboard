use super::processes::extension;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

fn spawn(program: &Path, args: &[&std::ffi::OsStr]) -> Result<Child, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|_| {
        format!(
            "Could not start {}.",
            program.file_name().unwrap_or_default().to_string_lossy()
        )
    })
}

// Reap detached launchers on Unix without blocking the scan loop or the command response.
pub(super) fn detach(child: Child) {
    #[cfg(unix)]
    {
        let mut child = child;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    #[cfg(not(unix))]
    drop(child);
}

#[cfg(windows)]
pub(super) fn ahk_executable(preferred: Option<&Path>) -> Result<PathBuf, String> {
    use super::processes::is_interpreter;
    if let Some(exe) =
        preferred.filter(|exe| exe.is_absolute() && is_interpreter(exe) && exe.is_file())
    {
        return Ok(exe.to_owned());
    }
    let mut dirs = Vec::new();
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            let root = PathBuf::from(root).join("AutoHotkey");
            dirs.extend([root.join("v2"), root]);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for dir in dirs.into_iter().filter(|d| d.is_absolute()) {
        for name in ["AutoHotkey64.exe", "AutoHotkey32.exe", "AutoHotkey.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("AutoHotkey was not found.".into())
}

#[cfg(windows)]
pub(super) fn launch_ahk(
    path: &Path,
    preferred: Option<&Path>,
    restart: bool,
) -> Result<Child, String> {
    if !path.is_absolute() || !path.is_file() || extension(path) != "ahk" {
        return Err("AutoHotkey script was not found.".into());
    }
    let exe = ahk_executable(preferred)?;
    if restart {
        spawn(&exe, &["/restart".as_ref(), path.as_os_str()])
    } else {
        spawn(&exe, &[path.as_os_str()])
    }
}

#[cfg(windows)]
pub(super) fn edit_ahk(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() || extension(path) != "ahk" {
        return Err("AutoHotkey script was not found.".into());
    }
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(root).join("Programs/Microsoft VS Code/Code.exe"));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(var) {
            candidates.push(PathBuf::from(root).join("Microsoft VS Code/Code.exe"));
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path_var).filter_map(|dir| {
            if !dir.is_absolute() || !dir.join("code.cmd").is_file() {
                return None;
            }
            Some(dir.parent()?.join("Code.exe"))
        }));
    }
    if let Some(exe) = candidates.iter().find(|p| p.is_absolute() && p.is_file()) {
        if let Ok(child) = spawn(exe, &[path.as_os_str()]) {
            detach(child);
            return Ok(());
        }
    }
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|_| "Could not reveal the script in Explorer.".into())
}

#[cfg(target_os = "macos")]
pub(super) fn launch_mac(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err("Automation script was not found.".into());
    }
    let executable = match extension(path).as_str() {
        "workflow" => "/usr/bin/automator",
        "scpt" | "applescript" => "/usr/bin/osascript",
        "app" => "/usr/bin/open",
        _ => return Err("Unsupported automation file type.".into()),
    };
    spawn(Path::new(executable), &[path.as_os_str()]).map(detach)
}

#[cfg(target_os = "macos")]
pub(super) fn open_mac(path: &Path, reveal: bool) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err("Automation script was not found.".into());
    }
    let args = if reveal {
        vec!["-R".as_ref(), path.as_os_str()]
    } else {
        vec!["-a".as_ref(), "Automator".as_ref(), path.as_os_str()]
    };
    spawn(Path::new("/usr/bin/open"), &args).map(detach)
}
