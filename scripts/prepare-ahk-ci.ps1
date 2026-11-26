$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'The portable test interpreter is provisioned only on a hosted runner.'
}
$zip = Join-Path $env:RUNNER_TEMP 'AutoHotkey_2.0.19.zip'
$folder = Join-Path $env:RUNNER_TEMP 'dashboard-ahk-v2'
Invoke-WebRequest 'https://github.com/AutoHotkey/AutoHotkey/releases/download/v2.0.19/AutoHotkey_2.0.19.zip' -OutFile $zip
if ((Get-FileHash $zip).Hash -ne '4E0D0E65655066A646A210951320FEAEF0729A3597177131ADAEC4066BEF5869') { throw 'AutoHotkey checksum mismatch.' }
Expand-Archive $zip -DestinationPath $folder
$exe = Get-Item (Join-Path $folder 'AutoHotkey64.exe')
"DASHBOARD_QA_AHK_EXE=$($exe.FullName)" >> $env:GITHUB_ENV
$folder >> $env:GITHUB_PATH
