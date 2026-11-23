# Install (or reinstall) the Windows scheduled task: one poll every 5 minutes, current user, no admin rights.
# Copies the poller into %LOCALAPPDATA%\muse-wake-poller\app so switching git branches never breaks it.
# The task ends itself after the pilot (EndBoundary 2026-11-28 00:00 ET); poller.js also refuses after 2026-11-27.
# -Validate: registers a DISABLED copy under another name, prints what Windows stored, deletes it. Changes nothing else.
param([switch]$Validate)
$ErrorActionPreference = 'Stop'
$TaskName = if ($Validate) { 'MusePilot-WakePoller-VALIDATE' } else { 'MusePilot-WakePoller' }
$home_ = Join-Path $env:LOCALAPPDATA 'muse-wake-poller'
$app = if ($Validate) { Join-Path $env:TEMP 'muse-wake-poller-validate' } else { Join-Path $home_ 'app' }
New-Item -ItemType Directory -Force -Path $app | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'lib.js'), (Join-Path $PSScriptRoot 'poller.js'), (Join-Path $PSScriptRoot 'run-poller.ps1') $app
# lib.js/poller.js are ES modules; give the copy its own package.json so node treats them that way.
'{ "type": "module", "private": true }' | Set-Content -Encoding ascii (Join-Path $app 'package.json')

if (-not $Validate -and -not (Test-Path (Join-Path $home_ 'creds\crosswalk-key.xml'))) { Write-Warning 'No Crosswalk key stored yet: run set-credentials.ps1 first. Installing anyway.' }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$psArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$app\run-poller.ps1`""
# conhost --headless keeps the 5-minute run from flashing a console window.
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$ps`" $psArgs" -WorkingDirectory $app

$end = '2026-11-28T00:00:00-05:00'
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$every5.EndBoundary = $end
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"   # first poll right after a restart + sign-in
$logon.EndBoundary = $end
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 9) -Hidden
if ($Validate) { $settings.Enabled = $false }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every5, $logon) -Settings $settings -Principal $principal `
  -Description 'muse-claude-pilot: polls Crosswalk museclaudepilot every 5 min, wakes the engineer routine for new tasks. Remove with uninstall-task.ps1.' -Force | Out-Null
$t = Get-ScheduledTask -TaskName $TaskName
if ($Validate) {
  try {
    $r = $t.Triggers[0]
    [pscustomobject]@{ State = $t.State; Enabled = $t.Settings.Enabled; Every = $r.Repetition.Interval; RepeatFor = $r.Repetition.Duration
      EndBoundary = $r.EndBoundary; LogonTrigger = $t.Triggers[1].CimClass.CimClassName; LogonType = $t.Principal.LogonType
      RunLevel = $t.Principal.RunLevel; MultipleInstances = $t.Settings.MultipleInstances; TimeLimit = $t.Settings.ExecutionTimeLimit
      StartWhenAvailable = $t.Settings.StartWhenAvailable; Execute = $t.Actions[0].Execute } | Format-List
  } finally {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'validate task not removed' }
    Write-Host 'VALIDATE OK: task registered disabled, read back, removed.'
  }
  return
}
Write-Host "Installed '$TaskName' (state: $($t.State)). Log: $home_\poller.log"
