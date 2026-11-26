use super::{now, Record};
use serde_json::json;
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub(super) fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn is_ahk(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("autohotkey") || name.contains("ahk")
}

#[cfg(windows)]
pub(super) fn is_interpreter(path: &Path) -> bool {
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    extension(path) == "exe"
        && matches!(
            stem.as_str(),
            "autohotkey"
                | "autohotkey64"
                | "autohotkey32"
                | "autohotkeyu64"
                | "autohotkeyu32"
                | "autohotkeya32"
                | "autohotkey64_uia"
                | "autohotkey32_uia"
        )
}

#[derive(Default)]
pub(super) struct Scanner {
    system: System,
}

impl Scanner {
    pub(super) fn scan(&mut self) -> Result<Vec<Record>, String> {
        #[cfg(windows)]
        {
            let count = self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            if count == 0 {
                return Err("Windows process enumeration failed.".into());
            }
            let pids: Vec<Pid> = self
                .system
                .processes()
                .iter()
                .filter(|(_, p)| is_ahk(&p.name().to_string_lossy()))
                .map(|(pid, _)| *pid)
                .collect();
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::OnlyIfNotSet)
                    .with_cwd(UpdateKind::OnlyIfNotSet)
                    .with_exe(UpdateKind::OnlyIfNotSet)
                    .with_cpu()
                    .with_memory(),
            );
            let mut result = Vec::new();
            for pid in pids {
                let Some(process) = self.system.process(pid) else {
                    continue;
                };
                let pid = pid.as_u32();
                let path = process
                    .cmd()
                    .iter()
                    .skip(1)
                    .map(PathBuf::from)
                    .find(|p| extension(p) == "ahk")
                    .and_then(|p| {
                        if p.is_absolute() {
                            Some(p)
                        } else {
                            process.cwd().map(|cwd| cwd.join(p))
                        }
                    });
                let mut item = json!({"key":pid.to_string(), "pid":pid,"processName":process.name().to_string_lossy(),
                    "firstSeen": now(), "lastSeen": now(),"cpu":process.cpu_usage(),"memory":process.memory()});
                if let Some(p) = &path {
                    item["scriptPath"] = json!(p);
                    item["scriptName"] = json!(p.file_name().unwrap_or_default().to_string_lossy());
                }
                result.push(Record {
                    item,
                    native_id: identity(pid, process.exe(), process.start_time()).ok(),
                    executable: process.exe().map(Path::to_owned),
                });
            }
            Ok(result)
        }
        #[cfg(target_os = "macos")]
        {
            let count = self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::Always)
                    .with_exe(UpdateKind::OnlyIfNotSet)
                    .with_memory()
                    .with_cpu(),
            );
            if count == 0 {
                return Err("macOS process enumeration failed.".into());
            }
            let rows: Vec<_> = self
                .system
                .processes()
                .values()
                .filter_map(|p| {
                    let exe = p.exe()?;
                    Some(super::macos::Process {
                        pid: p.pid().as_u32(),
                        ppid: p.parent().map(|v| v.as_u32()),
                        exe: exe.to_owned(),
                        args: p.cmd().iter().skip(1).map(PathBuf::from).collect(),
                        started: p.start_time(),
                        cpu: p.cpu_usage(),
                        memory: p.memory(),
                    })
                })
                .collect();
            let home = std::env::var_os("HOME").ok_or("macOS home directory unavailable.")?;
            super::macos::discover(&PathBuf::from(home).join("Library/Services"), &rows)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Ok(Vec::new())
        }
    }
}

#[cfg(windows)]
struct ProcessHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
impl ProcessHandle {
    fn open(pid: u32, access: u32) -> Result<Self, String> {
        if pid < 5 || pid == std::process::id() {
            return Err("Protected process.".into());
        }
        let handle = unsafe { windows_sys::Win32::System::Threading::OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return Err("The script has stopped or Windows denied access.".into());
        }
        Ok(Self(handle))
    }
    fn creation_time(&self) -> Result<u64, String> {
        use windows_sys::Win32::Foundation::FILETIME;
        let (mut birth, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let ok = unsafe {
            windows_sys::Win32::System::Threading::GetProcessTimes(
                self.0,
                &mut birth,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        };
        if ok == 0 {
            return Err("Script process identity could not be verified.".into());
        }
        Ok(((birth.dwHighDateTime as u64) << 32) | birth.dwLowDateTime as u64)
    }
}

#[cfg(windows)]
fn identity(pid: u32, executable: Option<&Path>, started: u64) -> Result<u64, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
    let handle = ProcessHandle::open(
        pid,
        windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
    )?;
    let mut buffer = vec![0; 32768];
    let mut len = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut len) };
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len as usize]));
    let stamp = handle.creation_time()?;
    let epoch_seconds = (stamp / 10_000_000).saturating_sub(11_644_473_600);
    if ok == 0 || executable != Some(path.as_path()) || epoch_seconds != started {
        return Err("The script process changed during discovery.".into());
    }
    Ok(stamp)
}

pub(super) fn stop(record: &Record) -> Result<(), String> {
    let pid = record.item["pid"]
        .as_u64()
        .and_then(|p| u32::try_from(p).ok())
        .ok_or("The script is not running.")?;
    let expected = record
        .native_id
        .ok_or("Script process identity is unavailable.")?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };
        let handle = ProcessHandle::open(
            pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
        )?;
        if handle.creation_time()? != expected {
            return Err("The script process changed. Refresh the dashboard.".into());
        }
        if unsafe { TerminateProcess(handle.0, 0) } == 0 {
            return Err("Windows could not stop the script.".into());
        }
        if unsafe { WaitForSingleObject(handle.0, 3000) } != 0 {
            return Err("Windows has not confirmed the script stopped.".into());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        use sysinfo::Signal;
        let mut sys = System::new();
        let id = Pid::from_u32(pid);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[id]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        let process = sys.process(id).ok_or("The script has stopped.")?;
        if pid <= 1
            || pid == std::process::id()
            || process.start_time() != expected
            || process.exe() != record.executable.as_deref()
        {
            return Err("The script process changed. Refresh the dashboard.".into());
        }
        if process.kill_with(Signal::Term) != Some(true) {
            return Err("macOS could not stop the script.".into());
        }
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (pid, expected);
        Err("Script management is unavailable on this platform.".into())
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;
    #[test]
    fn interpreter_names_are_exact() {
        assert!(is_interpreter(Path::new(r"C:\Foo\AutoHotkey64.exe")));
        assert!(!is_interpreter(Path::new(
            r"C:\Foo\AutoHotkey-downloader.exe"
        )));
    }
    #[test]
    #[ignore = "requires an installed AutoHotkey v2 interpreter"]
    fn live_dummy_ahk_scan_restart_stop() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("Local dashboard fixture with spaces.ahk");
        std::fs::write(
            &script,
            "#Requires AutoHotkey v2.0\n#SingleInstance Force\nPersistent\n",
        )
        .unwrap();
        let exe = super::super::launch::ahk_executable(None).unwrap();
        let mut child = std::process::Command::new(&exe)
            .arg(&script)
            .spawn()
            .unwrap();
        struct Guard<'a>(&'a mut std::process::Child);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let guard = Guard(&mut child);
        let mut scanner = Scanner::default();
        let observe = |scanner: &mut Scanner, pid| {
            for _ in 0..30 {
                let row = scanner.scan().unwrap().into_iter().find(|r| {
                    r.item["pid"] == pid
                        && r.item["scriptPath"] == script.to_string_lossy().as_ref()
                });
                if let Some(r) = row {
                    return r;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            panic!("Temporary AutoHotkey fixture did not appear");
        };
        let record = observe(&mut scanner, guard.0.id());
        let mut changed = record.clone();
        changed.native_id = record.native_id.map(|i| i + 1);
        assert!(stop(&changed).is_err());
        let mut restarted =
            super::super::launch::launch_ahk(&script, record.executable.as_deref(), true).unwrap();
        let restarted_guard = Guard(&mut restarted);
        let new_record = observe(&mut scanner, restarted_guard.0.id());
        assert_ne!(new_record.native_id, record.native_id);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while guard.0.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(guard
            .0
            .try_wait()
            .unwrap()
            .is_some_and(|exit| exit.success()));
        stop(&new_record).unwrap();
        assert!(restarted_guard.0.wait().unwrap().success());
        assert!(!scanner
            .scan()
            .unwrap()
            .iter()
            .any(|r| r.item["scriptPath"] == script.to_string_lossy().as_ref()));
    }
}
