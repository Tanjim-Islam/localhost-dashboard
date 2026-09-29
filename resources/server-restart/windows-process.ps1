# Private, line-delimited RPC. Input contains only PIDs and process identities.
# Contexts returned to main contain secrets and must never be logged or persisted.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class DashboardProcess {
  public int pid;
  public int ppid;
  public string started;
  public double startedMs;
  public string executable;
  public string[] argv;
  public string cwd;
  public Dictionary<string, string> env;
}

public static class DashboardNative {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] bytes, int size, out IntPtr read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, IntPtr data, int size, out int returned);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] pids, uint count);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);

  static byte[] Read(IntPtr h, long address, int size) {
    if (address <= 0 || size < 0 || size > 2097152) throw new Exception();
    byte[] bytes = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(address), bytes, size, out read) || read.ToInt64() != size) throw new Exception();
    return bytes;
  }
  static long Pointer(byte[] data, int offset, bool small) {
    return small ? BitConverter.ToUInt32(data, offset) : BitConverter.ToInt64(data, offset);
  }
  static string Unicode(IntPtr h, long parameters, int offset, bool small) {
    byte[] value = Read(h, parameters + offset, small ? 8 : 16);
    int size = BitConverter.ToUInt16(value, 0);
    return size == 0 ? "" : Encoding.Unicode.GetString(Read(h, Pointer(value, small ? 4 : 8, small), size));
  }
  static DashboardProcess Identity(IntPtr h, int pid) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(h, out created, out exited, out kernel, out user) || exited != 0) throw new Exception();
    var name = new StringBuilder(32768); int size = name.Capacity;
    if (!QueryFullProcessImageName(h, 0, name, ref size)) throw new Exception();
    IntPtr info = Marshal.AllocHGlobal(48);
    try {
      int returned;
      if (NtQueryInformationProcess(h, 0, info, 48, out returned) != 0) throw new Exception();
      return new DashboardProcess { pid=pid, ppid=(int)Marshal.ReadInt64(info, 40), started=created.ToString(),
        startedMs=(created - 116444736000000000L) / 10000.0, executable=name.ToString() };
    } finally { Marshal.FreeHGlobal(info); }
  }
  public static DashboardProcess Get(int pid, bool context) {
    if (IntPtr.Size != 8) throw new Exception("64-bit Windows is required.");
    IntPtr h = OpenProcess(context ? 0x410u : 0x400u, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      DashboardProcess p = Identity(h, pid);
      if (!context) return p;
      bool small;
      if (!IsWow64Process(h, out small)) throw new Exception();
      IntPtr info = Marshal.AllocHGlobal(48); long peb;
      try {
        int returned;
        if (NtQueryInformationProcess(h, small ? 26 : 0, info, small ? 8 : 48, out returned) != 0) throw new Exception();
        peb = Marshal.ReadInt64(info, small ? 0 : 8);
      } finally { Marshal.FreeHGlobal(info); }
      long parameters = Pointer(Read(h, peb + (small ? 0x10 : 0x20), small ? 4 : 8), 0, small);
      p.cwd = Unicode(h, parameters, small ? 0x24 : 0x38, small);
      string command = Unicode(h, parameters, small ? 0x40 : 0x70, small);
      int count; IntPtr args = CommandLineToArgvW(command, out count);
      if (args == IntPtr.Zero || count < 1 || count > 4096) throw new Exception();
      try {
        p.argv = new string[count];
        for (int i = 0; i < count; i++) p.argv[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, i * IntPtr.Size));
      } finally { LocalFree(args); }
      long environment = Pointer(Read(h, parameters + (small ? 0x48 : 0x80), small ? 4 : 8), 0, small);
      var buffer = new List<byte>(); bool complete = false;
      // Read no more than one memory page at a time. Stop at the UTF-16 double NUL.
      for (int offset = 0; offset < 2097152 && !complete;) {
        int size = (int)Math.Min(4096 - ((environment + offset) & 4095), 2097152 - offset);
        byte[] block = Read(h, environment + offset, size);
        buffer.AddRange(block);
        for (int j = Math.Max(0, offset - 2); j + 3 < buffer.Count; j += 2) {
          if (buffer[j] == 0 && buffer[j+1] == 0 && buffer[j+2] == 0 && buffer[j+3] == 0) {
            buffer.RemoveRange(j + 4, buffer.Count - j - 4); complete = true; break;
          }
        }
        offset += size;
      }
      if (!complete) throw new Exception();
      p.env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string entry in Encoding.Unicode.GetString(buffer.ToArray()).Split('\0')) {
        int separator = entry.IndexOf('=');
        if (separator > 0) p.env[entry.Substring(0, separator)] = entry.Substring(separator + 1);
      }
      return p;
    } catch { return null; } finally { CloseHandle(h); }
  }
  public static DashboardProcess[] List() {
    var result = new List<DashboardProcess>();
    foreach (Process process in Process.GetProcesses()) {
      using (process) { var item = Get(process.Id, false); if (item != null) result.Add(item); }
    }
    return result.ToArray();
  }
  public static bool Stop(int pid, string started, string executable) {
    IntPtr h = OpenProcess(0x401, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      var current = Identity(h, pid);
      return current.started == started && current.executable == executable && TerminateProcess(h, 1);
    } catch { return false; } finally { CloseHandle(h); }
  }
  public static bool Interrupt(int pid, uint[] allowed) {
    FreeConsole();
    if (!AttachConsole((uint)pid)) return false;
    try {
      SetConsoleCtrlHandler(IntPtr.Zero, true);
      uint[] console = new uint[256]; uint count = GetConsoleProcessList(console, 256);
      if (count == 0 || count > 256) return false;
      var safe = new HashSet<uint>(allowed); safe.Add((uint)Process.GetCurrentProcess().Id);
      for (int i = 0; i < count; i++) if (!safe.Contains(console[i])) return false;
      return GenerateConsoleCtrlEvent(0, 0);
    } finally { FreeConsole(); }
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.op -eq 'snapshot') {
      $processes = @([DashboardNative]::List())
      $contexts = @()
      $nextPid = [int]$request.pid
      for ($depth = 0; $depth -lt 16 -and $nextPid -gt 4; $depth++) {
        $record = $processes | Where-Object { $_.pid -eq $nextPid } | Select-Object -First 1
        if ($null -eq $record) { break }
        $context = [DashboardNative]::Get($nextPid, $true)
        if ($null -ne $context) { $contexts += $context }
        $nextPid = $record.ppid
      }
      $result = @{ processes=$processes; contexts=$contexts }
    } elseif ($request.op -eq 'stop') {
      $result = @()
      foreach ($target in $request.targets) {
        $result += [DashboardNative]::Stop([int]$target.pid, [string]$target.started, [string]$target.executable)
      }
    } elseif ($request.op -eq 'interrupt') {
      $valid = @()
      foreach ($target in $request.targets) {
        $current = [DashboardNative]::Get([int]$target.pid, $false)
        if ($null -ne $current -and $current.started -eq $target.started -and $current.executable -eq $target.executable) {
          $valid += [uint32]$target.pid
        }
      }
      $result = $valid.Count -eq $request.targets.Count -and [DashboardNative]::Interrupt([int]$request.pid, [uint32[]]$valid)
    } else { throw 'Invalid operation' }
    $response = @{ id=$request.id; result=$result } | ConvertTo-Json -Depth 9 -Compress
    [Console]::WriteLine($response)
  } catch {
    [Console]::WriteLine('{"error":"Process inspection failed."}')
  }
}
