# Install (or reinstall) the PC2 worker task 'MuseOps-PC2Worker' (owner-approved 2026-11-25, T-20261125-01).
# Every 10 minutes, current user, no admin rights, no end date. Copies the code to %LOCALAPPDATA%\muse-ops-worker\app.
# The worker prompt (private, not in this public repo) must be at %LOCALAPPDATA%\muse-ops-worker\worker-prompt.md.
param([switch]$Validate)
$ErrorActionPreference = 'Stop'
$TaskName = if ($Validate) { 'MuseOps-PC2Worker-VALIDATE' } else { 'MuseOps-PC2Worker' }
$home_ = Join-Path $env:LOCALAPPDATA 'muse-ops-worker'
$app = if ($Validate) { Join-Path $env:TEMP 'muse-ops-worker-validate' } else { Join-Path $home_ 'app' }
$src = Split-Path $PSScriptRoot -Parent
foreach ($d in 'pc2-worker', 'wake-poller') { New-Item -ItemType Directory -Force -Path (Join-Path $app $d) | Out-Null }
Copy-Item -Force (Join-Path $PSScriptRoot 'lib.js'), (Join-Path $PSScriptRoot 'worker.js') (Join-Path $app 'pc2-worker')
Copy-Item -Force (Join-Path $src 'wake-poller\lib.js'), (Join-Path $src 'wake-poller\poller.js') (Join-Path $app 'wake-poller')
Copy-Item -Force (Join-Path $PSScriptRoot 'run-worker.ps1') $app
'{ "type": "module", "private": true }' | Set-Content -Encoding ascii (Join-Path $app 'package.json')
if (-not $Validate -and -not (Test-Path (Join-Path $home_ 'worker-prompt.md'))) { Write-Warning 'worker-prompt.md missing: runs will log NO_PROMPT_FILE until it exists.' }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$ps`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$app\run-worker.ps1`"" -WorkingDirectory $app
$every10 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10)
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# 75 min limit = 60 min run timeout + slack. IgnoreNew + the worker's lock: never two runs at once.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 75) -Hidden -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
if ($Validate) { $settings.Enabled = $false }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every10, $logon) -Settings $settings -Principal $principal `
  -Description 'Muse ops: every 10 min, if a board task for Pilot Harness is open, runs ONE capped headless Claude Code session for it. Pause: create PAUSE in %LOCALAPPDATA%\muse-ops-worker.' -Force | Out-Null
$t = Get-ScheduledTask -TaskName $TaskName
if ($Validate) {
  try {
    [pscustomobject]@{ State = $t.State; Every = $t.Triggers[0].Repetition.Interval; End = $t.Triggers[0].EndBoundary; Limit = $t.Settings.ExecutionTimeLimit
      Multi = $t.Settings.MultipleInstances; Restart = "$($t.Settings.RestartCount)x $($t.Settings.RestartInterval)"; Logon = $t.Principal.LogonType; Level = $t.Principal.RunLevel } | Format-List
  } finally {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue
    Write-Host 'VALIDATE OK: registered disabled, read back, removed.'
  }
  return
}
Write-Host "Installed '$TaskName' (state: $($t.State)). Log: $home_\worker.log"
