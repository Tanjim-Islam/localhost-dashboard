param(
    [Parameter(Mandatory)][int]$DashboardPid,
    [Parameter(Mandatory)][string]$FixtureRoot,
    [Parameter(Mandatory)][ValidateSet('select','cancel')][string]$Action
)
$ErrorActionPreference = 'Stop'
$root = Get-Item -LiteralPath $FixtureRoot
if ($root.Parent.FullName -ne (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\') -or
    $root.Name -notlike 'dashboard-webview-*') {
    throw 'The picker test requires a generated WebView2 fixture.'
}
$selected = Get-Item -LiteralPath (Join-Path $root.FullName 'Additional CLI folder')
if (-not $selected.PSIsContainer -or ($selected.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The selected path must be the fixture directory.'
}
$process = Get-Process -Id $DashboardPid
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$element = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$pidFilter = [System.Windows.Automation.PropertyCondition]::new($element::ProcessIdProperty, $DashboardPid)
$dialogFilter = [System.Windows.Automation.PropertyCondition]::new($element::ClassNameProperty, '#32770')
$filter = [System.Windows.Automation.AndCondition]::new($pidFilter, $dialogFilter)
function Find-Picker {
    if ($process.HasExited) { throw 'The fixture process exited.' }
    $windows = $element::RootElement.FindAll($scope::Children, $filter)
    if ($windows.Count -gt 1) { throw 'More than one native dialog belongs to the fixture.' }
    if ($windows.Count -eq 1) { return $windows.Item(0) }
}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $dialog = Find-Picker
    if ($dialog) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (!$dialog) { throw 'The fixture folder picker did not open.' }
# The Win32 file dialog exposes a folder edit (edt1), OK and Cancel even when
# its accessibility tree hides those controls. Address those handles inside the
# fixture's dialog directly so another foreground window can never receive input.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class FixtureFolderPicker {
    const uint SetText = 0x000C, ButtonClick = 0x00F5, AbortIfHung = 2;
    delegate bool EnumProc(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root, EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, string value, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    static IntPtr Control(IntPtr dialog, uint pid, int id, string type) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(dialog, delegate(IntPtr handle, IntPtr state) {
            if (GetDlgCtrlID(handle) != id || !IsWindowVisible(handle)) return true;
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            var name = new StringBuilder(64);
            GetClassName(handle, name, name.Capacity);
            if (owner == pid && name.ToString() == type) { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero || !IsChild(dialog, found))
            throw new InvalidOperationException("The fixture picker is missing control " + id);
        return found;
    }

    public static void Choose(IntPtr dialog, uint pid, string folder) {
        uint owner;
        GetWindowThreadProcessId(dialog, out owner);
        if (pid != owner) throw new InvalidOperationException("The fixture picker closed.");
        var edit = Control(dialog, pid, 1152, "Edit");
        var ok = Control(dialog, pid, 1, "Button");
        var cancel = Control(dialog, pid, 2, "Button");
        var button = cancel;
        if (folder != null) {
            IntPtr result;
            if (SendMessageTimeout(edit, SetText, IntPtr.Zero, folder, AbortIfHung, 2000, out result) == IntPtr.Zero || result == IntPtr.Zero)
                throw new Win32Exception();
            button = ok;
        }
        if (!PostMessage(button, ButtonClick, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
    }
}
"@
if ($Action -eq 'select') {
    [FixtureFolderPicker]::Choose([IntPtr]$dialog.Current.NativeWindowHandle,$DashboardPid,$selected.FullName)
} else {
    [FixtureFolderPicker]::Choose([IntPtr]$dialog.Current.NativeWindowHandle,$DashboardPid,[NullString]::Value)
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ((Find-Picker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (Find-Picker) { throw 'The fixture picker did not close.' }
