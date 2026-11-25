# One worker check. Task Scheduler runs this every 10 minutes.
# Decrypts the SAME read-only Crosswalk key the wake poller uses (museclaudepilot only) into this process's
# environment for the board pre-check; the headless Claude Code run uses the owner's own Claude sign-in.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$home_ = Join-Path $env:LOCALAPPDATA 'muse-ops-worker'
try {
  $env:CROSSWALK_POLLER_KEY = (Import-Clixml (Join-Path $env:LOCALAPPDATA 'muse-wake-poller\creds\crosswalk-key.xml')).GetNetworkCredential().Password
  $node = (Get-Command node -ErrorAction Stop).Source
  $a = @((Join-Path $PSScriptRoot 'pc2-worker\worker.js'))
  if ($DryRun) { $a += '--dry-run' }
  & $node @a
  exit $LASTEXITCODE
} catch {
  $line = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); event = 'RUNNER_ERROR'; error = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
  New-Item -ItemType Directory -Force -Path $home_ | Out-Null
  Add-Content -Path (Join-Path $home_ 'worker.log') -Value $line
  exit 1
} finally {
  Remove-Item Env:CROSSWALK_POLLER_KEY -ErrorAction SilentlyContinue
}
