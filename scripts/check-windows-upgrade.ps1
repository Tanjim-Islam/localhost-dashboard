param([Parameter(Mandatory)][string]$Stage)
$ErrorActionPreference = 'Stop'
# This test installs real packages and runs their uninstallers. Use a disposable hosted runner.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'The installer migration check requires a fresh GitHub-hosted Windows runner.'
}
$legacyKey = 'HKCU:\Software\425ddd3d-3ae7-5130-a14e-d9f70edfb11c'
$legacyData = Join-Path $env:APPDATA 'local-dashboard'
$newData = Join-Path $env:APPDATA 'com.localdashboard.app'
$nativeDir = Join-Path $env:LOCALAPPDATA 'Localhost Dashboard'
foreach ($path in @($legacyKey, $legacyData, $newData, $nativeDir)) {
  if (Test-Path -LiteralPath $path) { throw 'The runner already contains dashboard data or an installation.' }
}
function Invoke-Installer([string]$Executable, [string[]]$Options) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Options -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) { throw 'Installer did not exit within three minutes.' }
  if ($process.ExitCode -ne 0) { throw "Installer returned $($process.ExitCode)." }
}
$old = Join-Path $env:RUNNER_TEMP 'Localhost-Dashboard-Setup-1.13.0.exe'
Invoke-WebRequest 'https://github.com/Tanjim-Islam/localhost-dashboard/releases/download/v1.13.0/Localhost-Dashboard-Setup-1.13.0.exe' -OutFile $old
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $old).Hash -ne '445ce9a0723753a72fbc7825151a97b1297044cd5e07292290c5b5bb990040ce') {
  throw 'Historical release checksum mismatch.'
}
Invoke-Installer $old @('/S')
$oldDir = (Get-ItemProperty -LiteralPath $legacyKey).InstallLocation
if ($oldDir -ne (Join-Path $env:LOCALAPPDATA 'Programs\local-dashboard') -or
    -not (Test-Path -LiteralPath (Join-Path $oldDir 'resources\app.asar'))) {
  throw 'The legacy installer produced an unexpected layout.'
}
New-Item -ItemType Directory -Path $legacyData -Force | Out-Null
$settingsFile = Join-Path $legacyData 'settings.json'
$marker = '{"scanIntervalMs":3210,"notifyOnStart":false,"notifyOnStop":false,"startAtLogin":false}'
[IO.File]::WriteAllText($settingsFile, $marker)
$userRun = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
if ($null -ne $userRun.GetValue('Localhost Dashboard')) { throw 'Existing login registration on the runner.' }
$userRun.SetValue('Localhost Dashboard', ('"{0}" --hidden' -f (Join-Path $oldDir 'Localhost Dashboard.exe')))
$installer = @(Get-ChildItem -LiteralPath $Stage -Filter 'Localhost-Dashboard-Setup-*.exe')
if ($installer.Count -ne 1) { throw 'Expected exactly one new installer.' }
Invoke-Installer $installer[0].FullName @('/S','--updated')
$nativeExe = Join-Path $nativeDir 'local-dashboard.exe'
if (-not (Test-Path -LiteralPath $nativeExe)) { throw 'Rust executable was not installed.' }
if ((Test-Path -LiteralPath (Join-Path $oldDir 'resources\app.asar')) -or (Test-Path -LiteralPath $legacyKey)) {
  throw 'Previous runtime or installation registration remains.'
}
if ([IO.File]::ReadAllText($settingsFile) -ne $marker) { throw 'Legacy settings were altered.' }
$app = Start-Process -FilePath $nativeExe -PassThru -WindowStyle Hidden
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $migration = Join-Path $newData 'migration-v1.json'
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $migration)) {
    if ($app.HasExited) { throw "Installed dashboard exited with $($app.ExitCode)." }
    Start-Sleep -Milliseconds 350
  }
  if (-not (Test-Path -LiteralPath $migration)) { throw 'The installed app did not migrate its profile.' }
  $migrated = Get-Content -Raw -LiteralPath (Join-Path $newData 'settings.json') | ConvertFrom-Json
  if ($migrated.scanIntervalMs -ne 3210) { throw 'Native settings do not match the legacy value.' }
  while ([DateTime]::UtcNow -lt $deadline -and $null -ne $userRun.GetValue('Localhost Dashboard')) {
    Start-Sleep -Milliseconds 150
  }
  if ($null -ne $userRun.GetValue('Localhost Dashboard')) { throw 'Disabled login preference left the previous executable registered.' }
} finally {
  $userRun.Dispose()
  if (-not $app.HasExited) { $app.Kill(); $app.WaitForExit() }
  $app.Dispose()
}
