# Store the poller's two credentials on this PC, DPAPI-protected (current Windows user only).
# Input is hidden (Read-Host -AsSecureString): never echoed, never in PowerShell history, never in the repo.
# Run in your own PowerShell window:  powershell -ExecutionPolicy Bypass -File .\set-credentials.ps1
#   -Only crosswalk | routine   re-enter just one of them (e.g. after a rotation)
param([ValidateSet('both', 'crosswalk', 'routine')][string]$Only = 'both')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'muse-wake-poller\creds'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Only this user (and SYSTEM) may read the folder.
icacls $dir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

function Save-Secret([string]$file, [string]$label, [string]$expectPrefix) {
  $sec = Read-Host -AsSecureString $label
  if ($sec.Length -lt 10) { throw "$label looks empty or too short; nothing saved." }
  $cred = [pscredential]::new('muse-wake-poller', $sec)
  $plainCheck = $cred.GetNetworkCredential().Password
  if ($expectPrefix -and -not $plainCheck.StartsWith($expectPrefix)) { Write-Warning "$label does not start with '$expectPrefix'. Saved anyway; check it if wakes fail." }
  Remove-Variable plainCheck
  $cred | Export-Clixml -Path (Join-Path $dir $file)   # Export-Clixml encrypts SecureString with DPAPI (CurrentUser)
  Write-Host "Saved $label (DPAPI, this user only): $(Join-Path $dir $file)"
}

if ($Only -in 'both', 'crosswalk') { Save-Secret 'crosswalk-key.xml' 'Crosswalk read-only key for museclaudepilot (input hidden)' $null }
if ($Only -in 'both', 'routine') { Save-Secret 'routine-token.xml' 'Routine API trigger token (input hidden)' 'sk-ant-oat01-' }
