#[cfg(not(windows))]
use std::collections::HashMap;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Eq, PartialEq, Hash)]
pub struct Identity {
    pub pid: u32,
    pub started: u64,
    pub unix_ms: u64,
    pub exe: PathBuf,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Listener {
    pub pid: u32,
    pub port: u16,
    pub ipv6: bool,
}

// Intentionally has no Serialize or Debug implementation. Only Launch is allowed to consume it.
#[derive(Clone)]
pub struct Context {
    pub id: Identity,
    pub cwd: PathBuf,
    pub argv: Vec<OsString>,
    pub env: BTreeMap<OsString, OsString>,
}
pub struct Table {
    pub system: System,
}
impl Default for Table {
    fn default() -> Self {
        Self {
            system: System::new(),
        }
    }
}
impl Table {
    pub fn refresh(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_exe(UpdateKind::OnlyIfNotSet),
        );
    }
    pub fn details(&mut self, pids: &[Pid]) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(pids),
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cmd(UpdateKind::Always)
                .with_cwd(UpdateKind::Always)
                .with_exe(UpdateKind::Always)
                .with_cpu()
                .with_memory(),
        );
    }
    pub fn process(&self, pid: u32) -> Option<&sysinfo::Process> {
        self.system.process(Pid::from_u32(pid))
    }
    pub fn parent(&self, pid: u32) -> Option<u32> {
        let child = self.process(pid)?;
        let ppid = child.parent()?.as_u32();
        if pid == ppid || self.process(ppid)?.start_time() > child.start_time() {
            return None;
        }
        Some(ppid)
    }
    pub fn ancestors(&self, pid: u32, limit: usize) -> Vec<u32> {
        let mut chain = vec![pid];
        while chain.len() < limit {
            let Some(ppid) = self.parent(*chain.last().unwrap()) else {
                break;
            };
            if chain.contains(&ppid) {
                break;
            }
            chain.push(ppid);
        }
        chain
    }
    pub fn descendants(&self, root: &Identity) -> Result<Vec<Identity>> {
        if identity(root.pid).as_ref() != Some(root) {
            return Err("Launcher identity changed.".into());
        }
        let mut found = vec![root.clone()];
        let mut pos = 0;
        while pos < found.len() {
            let parent = &found[pos];
            let parent_pid = parent.pid;
            let parent_started = parent.started;
            let children = self
                .system
                .processes()
                .values()
                .filter(|p| p.parent().map(|id| id.as_u32()) == Some(parent_pid));
            for child in children {
                let pid = child.pid().as_u32();
                if found.iter().any(|id| id.pid == pid) {
                    continue;
                }
                // A child we cannot identify makes terminating a launcher unsafe.
                let id = identity(pid).ok_or("A child process could not be verified.")?;
                if id.started >= parent_started {
                    found.push(id)
                }
                if found.len() > 128 {
                    return Err("This launcher has too many child processes.".into());
                }
            }
            pos += 1;
        }
        Ok(found)
    }
    pub fn context(&self, id: &Identity) -> Option<Context> {
        if identity(id.pid).as_ref() != Some(id) {
            return None;
        }
        // Keep the environment only in the recipe, never in the long-lived metrics cache.
        let mut system = System::new();
        let pid = Pid::from_u32(id.pid);
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cmd(UpdateKind::Always)
                .with_cwd(UpdateKind::Always)
                .with_environ(UpdateKind::Always),
        );
        let proc = system.process(pid)?;
        let mut env = BTreeMap::new();
        for entry in proc.environ() {
            let entry = entry.to_str()?;
            if let Some((key, value)) = entry.split_once('=') {
                if !key.is_empty() {
                    env.insert(key.into(), value.into());
                }
            }
        }
        let ctx = Context {
            id: id.clone(),
            argv: proc.cmd().to_vec(),
            cwd: proc.cwd()?.to_owned(),
            env,
        };
        (identity(id.pid).as_ref() == Some(id)).then_some(ctx)
    }
}

#[cfg(windows)]
pub use super::windows::{identity, listeners, service_names, stop};
#[cfg(not(windows))]
pub fn service_names() -> HashMap<u32, Vec<String>> {
    HashMap::new()
}

#[cfg(target_os = "macos")]
pub fn identity(pid: u32) -> Option<Identity> {
    use std::{ffi::OsStr, mem, os::unix::ffi::OsStrExt};
    unsafe {
        let mut info = mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = mem::size_of::<libc::proc_bsdinfo>() as i32;
        if libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        ) != size
        {
            return None;
        }
        let info = info.assume_init();
        let mut path = [0u8; 4096];
        let len = libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32);
        if len <= 0 {
            return None;
        }
        let end = path.iter().position(|&b| b == 0)?;
        let started = info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec;
        Some(Identity {
            pid,
            started,
            unix_ms: started / 1000,
            exe: OsStr::from_bytes(&path[..end]).into(),
        })
    }
}
#[cfg(target_os = "macos")]
pub fn stop(id: &Identity) -> Result<()> {
    if identity(id.pid).as_ref() != Some(id) {
        return Err("Process identity changed.".into());
    }
    if unsafe { libc::kill(id.pid as i32, libc::SIGKILL) } != 0 {
        return Err("Access to this process was denied.".into());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn listeners() -> Result<Vec<Listener>> {
    use std::{
        io::Read,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fptn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not query local listeners.")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        stdout
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut buf)
            .map(|_| buf)
    });
    let errors = thread::spawn(move || {
        let mut buf = Vec::new();
        stderr.take(65536).read_to_end(&mut buf).map(|_| buf)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not query local listeners.")?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Local listener query timed out.".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let data = reader
        .join()
        .ok()
        .and_then(|r| r.ok())
        .ok_or("Cannot read listener table.")?;
    let error = errors
        .join()
        .ok()
        .and_then(|r| r.ok())
        .ok_or("Cannot read listener table.")?;
    if data.len() > 4 * 1024 * 1024
        || !error.is_empty()
        || (!status.success() && !(status.code() == Some(1) && data.is_empty()))
    {
        return Err("Could not read the complete local listener table.".into());
    }
    let mut result = Vec::new();
    let (mut pid, mut ipv6) = (0, false);
    for line in String::from_utf8_lossy(&data).lines() {
        if let Some(v) = line.strip_prefix('p') {
            pid = v.parse().unwrap_or(0)
        } else if let Some(v) = line.strip_prefix('t') {
            ipv6 = v == "IPv6"
        } else if let Some(v) = line.strip_prefix('n') {
            if let Some(port) = v.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()) {
                if pid > 0 && port > 0 {
                    result.push(Listener { pid, port, ipv6 })
                }
            }
        }
    }
    Ok(result)
}
#[cfg(target_os = "linux")]
pub fn identity(pid: u32) -> Option<Identity> {
    let path = format!("/proc/{pid}");
    let stat = std::fs::read_to_string(format!("{path}/stat")).ok()?;
    let started = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()?;
    let unix_ms = std::fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("btime ")?.parse::<u64>().ok())?
        * 1000
        + started * 1000 / (unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64);
    Some(Identity {
        pid,
        started,
        unix_ms,
        exe: std::fs::read_link(format!("{path}/exe")).ok()?,
    })
}
#[cfg(target_os = "linux")]
pub fn stop(_: &Identity) -> Result<()> {
    Err("Verified process controls require Windows or macOS.".into())
}
#[cfg(target_os = "linux")]
pub fn listeners() -> Result<Vec<Listener>> {
    use std::fs;
    let mut sockets = HashMap::new();
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        let data = match fs::read_to_string(file) {
            Ok(d) => d,
            Err(e) if v6 && e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Cannot read listener table.".into()),
        };
        for line in data.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() > 9 && fields[3] == "0A" {
                if let Some(port) = fields[1]
                    .rsplit(':')
                    .next()
                    .and_then(|p| u16::from_str_radix(p, 16).ok())
                {
                    sockets.insert(
                        format!("socket:[{}]", fields[9]),
                        Listener {
                            pid: 0,
                            port,
                            ipv6: v6,
                        },
                    );
                }
            }
        }
    }
    let mut result = Vec::new();
    for entry in fs::read_dir("/proc")
        .map_err(|_| "Cannot read process table.")?
        .flatten()
    {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if let Some(l) = fs::read_link(fd.path())
                .ok()
                .and_then(|p| sockets.get_mut(p.to_str()?))
            {
                l.pid = pid;
                result.push(*l);
            }
        }
    }
    result.extend(sockets.into_values().filter(|l| l.pid == 0));
    Ok(result)
}
