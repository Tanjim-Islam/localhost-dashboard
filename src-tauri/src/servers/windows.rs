use super::native::{Identity, Listener, Result};
use std::{collections::HashMap, mem, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA, FILETIME, HANDLE},
    NetworkManagement::IpHelper::*,
    Networking::WinSock::{AF_INET, AF_INET6},
    System::{Services::*, Threading::*},
};

pub fn open_terminal(path: &std::path::Path) -> Result<Identity> {
    use std::os::windows::ffi::OsStrExt;
    let directory = super::project::display(path);
    if !path.is_dir() || directory.as_bytes().get(1) != Some(&b':') || !path.is_absolute() {
        return Err("Select a local project folder.".into());
    }
    let root = std::env::var_os("SystemRoot").ok_or("Windows directory not found.")?;
    let binary = std::path::PathBuf::from(root).join("System32/cmd.exe");
    let exe: Vec<u16> = binary.as_os_str().encode_wide().chain([0]).collect();
    let folder: Vec<u16> = directory.encode_utf16().chain([0]).collect();
    let mut command: Vec<u16> = "cmd.exe /d /k".encode_utf16().chain([0]).collect();
    let startup = STARTUPINFOW {
        cb: mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: 1,
        ..Default::default()
    };
    let mut child = PROCESS_INFORMATION::default();
    // No inherited pipes or STARTF_USESTDHANDLES. The new console supplies
    // its own interactive input/output, including when Tauri is a GUI process.
    if unsafe {
        CreateProcessW(
            exe.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_NEW_CONSOLE,
            ptr::null(),
            folder.as_ptr(),
            &startup,
            &mut child,
        )
    } == 0
    {
        return Err("Could not open terminal.".into());
    }
    let handle = ProcessHandle(child.hProcess);
    unsafe {
        CloseHandle(child.hThread);
    }
    if unsafe { WaitForSingleObject(handle.0, 350) } != windows_sys::Win32::Foundation::WAIT_TIMEOUT
    {
        return Err("Terminal exited before opening.".into());
    }
    handle
        .identity(child.dwProcessId)
        .ok_or_else(|| "Could not verify the new terminal.".into())
}

fn listener_table<T: Copy>(family: u16, decode: impl Fn(T) -> (u32, u32)) -> Result<Vec<Listener>> {
    let mut bytes = 0_u32;
    let mut table = Vec::<u32>::new();
    for _ in 0..5 {
        let buffer = if table.is_empty() {
            ptr::null_mut()
        } else {
            table.as_mut_ptr().cast()
        };
        // Both table formats consist of a DWORD count and DWORD-aligned rows.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer,
                &mut bytes,
                0,
                family.into(),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER && bytes <= 16 * 1024 * 1024 {
            table.resize((bytes as usize).div_ceil(4), 0);
            continue;
        }
        if status != 0 || table.is_empty() {
            break;
        }
        let count = table[0] as usize;
        if count > (table.len() - 1) * 4 / mem::size_of::<T>() {
            break;
        }
        let rows = unsafe { std::slice::from_raw_parts(table.as_ptr().add(1).cast::<T>(), count) };
        return Ok(rows
            .iter()
            .filter_map(|row| {
                let (pid, raw_port) = decode(*row);
                let port = u16::from_be(raw_port as u16);
                (port > 0 && pid > 0).then_some(Listener {
                    pid,
                    port,
                    ipv6: family == AF_INET6,
                })
            })
            .collect());
    }
    Err("Windows could not read the local TCP listener table.".into())
}

pub fn listeners() -> Result<Vec<Listener>> {
    let mut table = listener_table(AF_INET, |r: MIB_TCPROW_OWNER_PID| {
        (r.dwOwningPid, r.dwLocalPort)
    })?;
    table.extend(listener_table(AF_INET6, |r: MIB_TCP6ROW_OWNER_PID| {
        (r.dwOwningPid, r.dwLocalPort)
    })?);
    Ok(table)
}

struct ProcessHandle(HANDLE);
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
impl ProcessHandle {
    fn open(pid: u32, access: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | access, 0, pid) };
        (!handle.is_null()).then(|| Self(handle))
    }
    fn identity(&self, pid: u32) -> Option<Identity> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok =
            unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) };
        if ok == 0 || exited.dwLowDateTime != 0 || exited.dwHighDateTime != 0 {
            return None;
        }
        let mut name = vec![0u16; 32768];
        let mut len = name.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.0, 0, name.as_mut_ptr(), &mut len) } == 0 {
            return None;
        }
        let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        Some(Identity {
            pid,
            started: ticks,
            unix_ms: ticks.checked_sub(116444736000000000)? / 10000,
            exe: String::from_utf16(&name[..len as usize]).ok()?.into(),
        })
    }
}
pub fn identity(pid: u32) -> Option<Identity> {
    ProcessHandle::open(pid, 0)?.identity(pid)
}

pub fn interrupt(tree: &[Identity]) -> bool {
    use windows_sys::Win32::System::Console::*;
    let Some(root) = tree.first() else {
        return false;
    };
    if tree.iter().any(|id| identity(id.pid).as_ref() != Some(id)) {
        return false;
    }
    // Never detach an existing dashboard or developer console. AttachConsole
    // simply fails when the caller already has one.
    unsafe {
        if AttachConsole(root.pid) == 0 {
            return false;
        }
        let mut pids = [0u32; 256];
        let count = GetConsoleProcessList(pids.as_mut_ptr(), 256) as usize;
        let ours = std::process::id();
        let safe = count > 0
            && count <= pids.len()
            && pids[..count].iter().all(|&pid| {
                pid == ours
                    || tree
                        .iter()
                        .any(|id| id.pid == pid && identity(pid).as_ref() == Some(id))
            });
        let sent = safe
            && SetConsoleCtrlHandler(None, 1) != 0
            && GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        FreeConsole();
        sent
    }
}

pub fn stop(id: &Identity) -> Result<()> {
    let handle = ProcessHandle::open(id.pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE)
        .ok_or("Access to this process was denied.")?;
    if handle.identity(id.pid).as_ref() != Some(id) {
        return Err("The process identity changed.".into());
    }
    // Compare and terminate through the same kernel object. PID reuse cannot redirect the stop.
    if unsafe { TerminateProcess(handle.0, 1) } == 0
        || unsafe { WaitForSingleObject(handle.0, 3000) } != 0
    {
        return Err("Windows did not confirm that the process stopped.".into());
    }
    Ok(())
}

pub fn service_names() -> HashMap<u32, Vec<String>> {
    let mut result: HashMap<u32, Vec<String>> = HashMap::new();
    unsafe {
        let scm = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ENUMERATE_SERVICE);
        if scm.is_null() {
            return result;
        }
        let mut resume = 0;
        // A page has pointer-aligned service records and strings owned by the same buffer.
        let mut page = vec![0usize; 256 * 1024 / mem::size_of::<usize>()];
        for _ in 0..32 {
            let mut needed = 0;
            let mut count = 0;
            let ok = EnumServicesStatusExW(
                scm,
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_ACTIVE,
                page.as_mut_ptr().cast(),
                (page.len() * mem::size_of::<usize>()) as u32,
                &mut needed,
                &mut count,
                &mut resume,
                ptr::null(),
            );
            let more = ok == 0 && windows_sys::Win32::Foundation::GetLastError() == ERROR_MORE_DATA;
            if ok == 0 && !more {
                break;
            }
            let entries = std::slice::from_raw_parts(
                page.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(),
                count as usize,
            );
            for entry in entries {
                let pid = entry.ServiceStatusProcess.dwProcessId;
                if pid == 0 || entry.lpDisplayName.is_null() {
                    continue;
                }
                let mut len = 0;
                while len < 256 && *entry.lpDisplayName.add(len) != 0 {
                    len += 1
                }
                result
                    .entry(pid)
                    .or_default()
                    .push(String::from_utf16_lossy(std::slice::from_raw_parts(
                        entry.lpDisplayName,
                        len,
                    )));
            }
            if !more || count == 0 {
                break;
            }
        }
        CloseServiceHandle(scm);
    }
    for names in result.values_mut() {
        names.sort();
    }
    result
}
