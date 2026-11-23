# ONE-STEP SETUP for the wake poller. Run in your own PowerShell window on PC2:
#   powershell -ExecutionPolicy Bypass -File C:\Users\mslug\muse-claude-pilot\tools\wake-poller\setup.ps1
# It opens the two pages where you create the credentials, takes each one with hidden input, stores both
# DPAPI-encrypted for your Windows user, checks the Crosswalk key against the board, does a dry run, and installs
# the 5-minute scheduled task. Nothing is echoed, logged or written to history. Safe to re-run.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

Write-Host ''
Write-Host '== Wake poller setup (muse-claude-pilot) ==' -ForegroundColor Cyan
Write-Host 'Opening the two pages you need. Create each credential, then paste it when asked (input is hidden).'
Write-Host ''
Write-Host '1) Routine token: routine "muse-claude-pilot engineer (Crosswalk wake)" > Edit > Trigger + > API > Generate token.'
Start-Process 'https://claude.ai/code/routines'
Write-Host '2) Crosswalk key: name "Wake Poller (PC2 script)", scope READ ONLY, rooms museclaudepilot ONLY (if offered).'
Start-Process 'https://crosswalk.to/keys?for=Wake%20Poller%20(PC2%20script)'
Write-Host ''

& (Join-Path $here 'set-credentials.ps1')

Write-Host ''
Write-Host 'Checking the Crosswalk key can read the board...'
& (Join-Path $here 'run-poller.ps1') -Check
if ($LASTEXITCODE -ne 0) { throw 'Crosswalk key check failed (see poller.log). Re-run: set-credentials.ps1 -Only crosswalk, then setup.ps1.' }

Write-Host 'Dry run (reads the board, fires nothing)...'
& (Join-Path $here 'run-poller.ps1') -DryRun

Write-Host 'Installing the scheduled task...'
& (Join-Path $here 'install-task.ps1')

Write-Host ''
Write-Host 'DONE. Tell Claude "creds stored" - it verifies the key scope, posts READY to Muse and runs the live test.' -ForegroundColor Green
