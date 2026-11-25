# Operations runbook: Muse ↔ Claude development operation

Permanent since 2026-11-25. Runs until the owner says stop.

## Components
| Component | Where | Schedule | Checks |
|---|---|---|---|
| Engineer routine (cloud) `trig_01LMfSREdryexCsAJYhHCrY4` | claude.ai routines; repo `mslugga35/muse-claude-pilot` + Crosswalk only | `5 0-3,13-23 * * *` UTC (hourly 8:05 AM–10:05 PM ET + wakes) | RemoteTrigger `get` → `enabled`, `next_run_at`; `list_runs` |
| Verifier routine (cloud) `trig_017pEXRVsm22g9jigM5LN3No` | claude.ai routines; read-only | `50 23 * * *` UTC (6:50 PM ET) | daily `[VERIFY <date>]` post for Pilot Harness |
| Wake poller `MusePilot-WakePoller` | PC2 Task Scheduler, `%LOCALAPPDATA%\muse-wake-poller` | every 5 min, 08:05–22:05 ET | `Get-ScheduledTaskInfo MusePilot-WakePoller`; `poller.log` |
| Muse (PM/QA) | Muse's own scheduler | about every 9–15 min | board activity |

## Recovery behaviour
| Failure | What happens |
|---|---|
| PC2 restart | Logon trigger polls at sign-in; `StartWhenAvailable` runs a missed poll as soon as possible. |
| Poll crashes | Task Scheduler restarts it up to 3 times, 5 min apart (`RestartCount 3`, `PT5M`). |
| Two polls at once | Impossible: `MultipleInstances IgnoreNew` + the poller's atomic lock directory (stale after 9 min). |
| Wake fails | 429 retried ≤3 times after `Retry-After`; timeouts/5xx marked `UNCERTAIN` and never retried (no duplicate sessions); 4xx `FAILED`. The hourly run still catches the task. |
| Runaway API use | ≤3 wake attempts per rolling hour; one task in flight at a time (90 min); no wakes outside 08:05–22:05 ET. |
| Engineer silent / task stalled | Muse posts WAKE_FAILED/STALLED report flags for Pilot Harness; the verifier's HEARTBEAT check lists stalled tasks daily. |
| Routine run fails | No auto-retry by design; the next hourly run picks the task up again (routine reads the last 2 days of the board). |

## Pause / stop (only on the owner's word)
- Pause poller: `tools\wake-poller\uninstall-task.ps1 -Disable`; resume: `Enable-ScheduledTask MusePilot-WakePoller`.
- Pause routines: RemoteTrigger `update` with `{"enabled": false}` (or claude.ai/code/routines).
- Full teardown: `uninstall-task.ps1 -RemoveCredentials`, delete the routine API token, revoke the `Wake Poller (PC2 script)` Crosswalk key, disable both routines.

## Optional end date
`%LOCALAPPDATA%\muse-wake-poller\config.json` → `"pilotEnd": "YYYY-MM-DD"` (Eastern). Default is none.
