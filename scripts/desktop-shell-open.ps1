param(
  [Parameter(Mandatory)][ValidateSet('install-handler','remove-handler','selected-file','edited-file','diagnostics','toast-setting','toast-started','toast-stopped')][string]$Action,
  [Parameter(Mandatory)][string]$FixtureDirectory,
  [Parameter(Mandatory)][string]$File
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Desktop-wide shell checks require a disposable hosted runner.'
}
$root = [IO.Path]::GetFullPath($FixtureDirectory)
if ([IO.Directory]::GetParent($root).FullName -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
    [IO.Path]::GetFileName($root) -notlike 'dashboard-shell-*') { throw 'Invalid fixture root.' }
$target = [IO.Path]::GetFullPath($File)
if (!$target.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test target.' }
$registry = [Microsoft.Win32.Registry]::CurrentUser
$key = 'Software\Classes\vscode'
$marker = 'Local Dashboard QA ' + [IO.Path]::GetFileName($root)
if ($Action -eq 'install-handler') {
  if ($registry.OpenSubKey($key)) { throw 'The runner profile already contains a per-user vscode handler.' }
  $handler = $registry.CreateSubKey($key)
  try {
    $handler.SetValue('', 'URL:VS Code Protocol')
    $handler.SetValue('URL Protocol', '')
    $handler.SetValue('LocalDashboardFixture', $marker)
    $open = $handler.CreateSubKey('shell\open\command')
    try { $open.SetValue('', ('"{0}" record-uri "{1}\received-uri.txt" "%1"' -f $target,$root)) }
    finally { $open.Dispose() }
  } finally { $handler.Dispose() }
} elseif ($Action -eq 'remove-handler') {
  $handler = $registry.OpenSubKey($key)
  if ($handler) {
    $ours = $handler.GetValue('LocalDashboardFixture') -eq $marker
    $handler.Dispose()
    if ($ours) { $registry.DeleteSubKeyTree($key) }
  }
} elseif ($Action -like 'toast-*') {
  $manager = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
  $appId = 'com.localdashboard.app'
  if ($Action -eq 'toast-setting') {
    Write-Output ($manager::CreateToastNotifier($appId).Setting.ToString())
    return
  }
  $title = if ($Action -eq 'toast-started') { 'AHK Script Started' } else { 'AHK Script Stopped' }
  foreach ($toast in $manager::History.GetHistory($appId)) {
    $xml = [xml]$toast.Content.GetXml()
    $values = @($xml.GetElementsByTagName('text') | ForEach-Object InnerText)
    if ($values -contains $title -and $values -contains [IO.Path]::GetFileName($target)) { Write-Output 'delivered'; return }
  }
} else {
  if ($Action -eq 'edited-file') {
    $fileName = [IO.Path]::GetFileName($target)
    foreach ($editor in [Diagnostics.Process]::GetProcessesByName('Code')) {
      if ($editor.MainWindowTitle.Contains($fileName)) { Write-Output 'editor'; return }
    }
  }
  $shell = New-Object -ComObject Shell.Application
  $explorerFolder = $shell.NameSpace([IO.Path]::GetDirectoryName($target))
  $explorerPath = $explorerFolder.ParseName([IO.Path]::GetFileName($target)).Path
  if ($Action -eq 'diagnostics') {
    $codePaths = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", "$env:ProgramFiles\Microsoft VS Code\Code.exe", "${env:ProgramFiles(x86)}\Microsoft VS Code\Code.exe")
    $codeInstalled = @($codePaths | Where-Object { Test-Path -LiteralPath $_ }).Count
    $codeWindows = @([Diagnostics.Process]::GetProcessesByName('Code') | Where-Object MainWindowHandle -ne 0).Count
    $explorerWindows = @($shell.Windows() | Where-Object { [IO.Path]::GetFileName($_.FullName) -ieq 'explorer.exe' }).Count
    $targetWindows = @($shell.Windows() | Where-Object { $_.Document.Folder.Self.Path -eq [IO.Path]::GetDirectoryName($explorerPath) }).Count
    "Hosted fixture editor binaries=$codeInstalled code windows=$codeWindows Explorer windows=$explorerWindows target folders=$targetWindows"
    return
  }
  foreach ($window in $shell.Windows()) {
    if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
    if ($window.Document.Folder.Self.Path -ine [IO.Path]::GetDirectoryName($explorerPath)) { continue }
    foreach ($selection in $window.Document.SelectedItems()) {
      if ($selection.Path -eq $explorerPath) { Write-Output 'selected'; return }
    }
  }
}
