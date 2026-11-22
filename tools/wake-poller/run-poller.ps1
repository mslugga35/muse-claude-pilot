# One poll. Task Scheduler runs this every 5 minutes. Decrypts the DPAPI-protected credentials into
# environment variables of THIS process only (inherited by node, never persisted), then runs poller.js.
param([switch]$DryRun, [switch]$Check)
$ErrorActionPreference = 'Stop'
$home_ = Join-Path $env:LOCALAPPDATA 'muse-wake-poller'
$creds = Join-Path $home_ 'creds'
try {
  $env:CROSSWALK_POLLER_KEY = (Import-Clixml (Join-Path $creds 'crosswalk-key.xml')).GetNetworkCredential().Password
  $tokFile = Join-Path $creds 'routine-token.xml'
  if (Test-Path $tokFile) { $env:ROUTINE_FIRE_TOKEN = (Import-Clixml $tokFile).GetNetworkCredential().Password }
  $node = (Get-Command node -ErrorAction Stop).Source
  $argsList = @((Join-Path $PSScriptRoot 'poller.js'))
  if ($DryRun) { $argsList += '--dry-run' }
  if ($Check) { $argsList += '--check' }
  & $node @argsList
  exit $LASTEXITCODE
} catch {
  # Never print the exception object (could carry a path to a secret); one plain line to the poller log.
  $line = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); event = 'RUNNER_ERROR'; error = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
  New-Item -ItemType Directory -Force -Path $home_ | Out-Null
  Add-Content -Path (Join-Path $home_ 'poller.log') -Value $line
  exit 1
} finally {
  Remove-Item Env:CROSSWALK_POLLER_KEY, Env:ROUTINE_FIRE_TOKEN -ErrorAction SilentlyContinue
}
