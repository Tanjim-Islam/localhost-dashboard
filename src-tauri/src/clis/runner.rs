use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const ALLOWED_ENV: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "TEMP",
    "TMP",
    "PATH",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "SCOOP",
    "CARGO_HOME",
    "PIPX_HOME",
    "PIPX_BIN_DIR",
    "PNPM_HOME",
];
pub(super) struct Plan {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}
impl Plan {
    pub fn new(exe: &Path, args: &[&str]) -> Self {
        Self {
            exe: exe.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: vec![],
        }
    }
}
pub(super) fn run(
    plan: &Plan,
    cwd: &Path,
    cancel: &AtomicBool,
    timeout: Duration,
    limit: usize,
) -> Result<String, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Scan cancelled.".into());
    }
    if !plan.exe.is_absolute()
        || !cwd.is_absolute()
        || !plan.exe.is_file()
        || plan.args.len() > 64
        || plan
            .args
            .iter()
            .any(|v| v.len() > 16384 || v.contains('\0'))
        || plan.args.iter().map(String::len).sum::<usize>() > 24576
        || !(1..=8 * 1024 * 1024).contains(&limit)
        || timeout > Duration::from_secs(120)
    {
        return Err("Invalid CLI command.".into());
    }
    #[cfg(windows)]
    if !plan
        .exe
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("com"))
    {
        return Err("This launcher cannot run directly.".into());
    }
    let mut command = Command::new(&plan.exe);
    command
        .current_dir(cwd)
        .args(&plan.args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ALLOWED_ENV {
        if let Some(v) = env::var_os(key) {
            command.env(key, v);
        }
    }
    for (k, v) in &plan.env {
        if matches!(
            k.as_str(),
            "npm_config_ignore_scripts"
                | "npm_config_yes"
                | "HOMEBREW_NO_AUTO_UPDATE"
                | "HOMEBREW_NO_ANALYTICS"
                | "PIP_DISABLE_PIP_VERSION_CHECK"
                | "PIPX_HOME"
                | "SCOOP"
                | "YARN_IGNORE_PATH"
                | "SKIP_YARN_COREPACK_CHECK"
        ) {
            command.env(k, v);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "The selected command could not be started.")?;
    let (send, recv) = mpsc::channel();
    fn drain(
        reader: impl Read + Send + 'static,
        cap: usize,
        stderr: bool,
        send: mpsc::Sender<(bool, Result<Vec<u8>, String>)>,
    ) {
        thread::spawn(move || {
            let mut data = Vec::new();
            let result = reader
                .take(cap as u64 + 1)
                .read_to_end(&mut data)
                .map_err(|_| "Command output could not be read.".to_owned())
                .and_then(|_| {
                    if data.len() > cap {
                        Err("Command output exceeded its limit.".to_owned())
                    } else {
                        Ok(data)
                    }
                });
            let _ = send.send((stderr, result));
        });
    }
    drain(child.stdout.take().unwrap(), limit, false, send.clone());
    drain(child.stderr.take().unwrap(), 256 * 1024, true, send);
    let until = Instant::now() + timeout;
    let mut out = None;
    let mut err = None;
    let result = loop {
        if cancel.load(Ordering::Acquire) {
            break Err("Scan cancelled.".into());
        }
        if Instant::now() >= until {
            break Err("The command exceeded its time limit.".into());
        }
        match recv.recv_timeout(Duration::from_millis(15)) {
            Ok((true, Ok(data))) => err = Some(data),
            Ok((false, Ok(data))) => out = Some(data),
            Ok((_, Err(e))) => break Err(e),
            Err(mpsc::RecvTimeoutError::Disconnected) if out.is_some() && err.is_some() => {
                thread::sleep(Duration::from_millis(10))
            }
            _ => {}
        }
        if out.is_some() && err.is_some() {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    let data = out.take().unwrap();
                    break Ok(String::from_utf8_lossy(&data).into_owned());
                }
                Ok(Some(_)) => break Err("The package command failed.".into()),
                Err(_) => break Err("Could not verify command completion.".into()),
                _ => {}
            }
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
