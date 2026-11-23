# Stop and remove the wake poller. -RemoveCredentials also deletes the DPAPI credential files.
# Revoking the credentials themselves is separate (README "Teardown"): local deletion does not revoke them.
param([switch]$RemoveCredentials, [switch]$Disable)
$ErrorActionPreference = 'Stop'
$TaskName = 'MusePilot-WakePoller'
$home_ = Join-Path $env:LOCALAPPDATA 'muse-wake-poller'
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Disable) {
  if ($t) { Disable-ScheduledTask -TaskName $TaskName | Out-Null; Write-Host "Disabled '$TaskName' (kept installed)." } else { Write-Host 'Task not installed.' }
  return
}
if ($t) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed '$TaskName'." }
else { Write-Host 'Task not installed.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task still present after removal.' }
Remove-Item -Recurse -Force (Join-Path $home_ 'app') -ErrorAction SilentlyContinue
if ($RemoveCredentials) { Remove-Item -Recurse -Force (Join-Path $home_ 'creds') -ErrorAction SilentlyContinue; Write-Host 'Deleted local credential files.' }
Write-Host "Kept log + wake history (evidence): $home_\poller.log, $home_\state.json"
