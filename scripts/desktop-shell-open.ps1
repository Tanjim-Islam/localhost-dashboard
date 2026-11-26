param(
  [Parameter(Mandatory)][ValidateSet('install-handler','remove-handler','selected-file')][string]$Action,
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
} else {
  $shell = New-Object -ComObject Shell.Application
  foreach ($window in $shell.Windows()) {
    foreach ($selection in $window.Document.SelectedItems()) {
      if ($selection.Path -eq $target) { Write-Output 'selected'; return }
    }
  }
}
