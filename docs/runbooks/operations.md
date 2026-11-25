# Operations runbook: Muse ↔ Claude development operation

Permanent and continuous since 2026-11-25 (OPERATING MODEL v2, post `kjo2vy`): all day, every day, until the owner
says stop. Spend is bounded by caps, not by hours.

## Components
| Component | Where | Schedule | Checks |
|---|---|---|---|
| Engineer routine (cloud) `trig_01LMfSREdryexCsAJYhHCrY4` | claude.ai routines; repo `mslugga35/muse-claude-pilot` + Crosswalk only | `5 * * * *` UTC (hourly, 24/7) + wakes; FAILOVER rule 3c takes stalled pilot-repo harness tasks | RemoteTrigger `get` → `enabled`, `next_run_at`; `list_runs` |
| Verifier routine (cloud) `trig_017pEXRVsm22g9jigM5LN3No` | claude.ai routines; read-only | `50 23 * * *` UTC (6:50 PM ET) | daily `[VERIFY <date>]` post for Pilot Harness |
| Wake poller `MusePilot-WakePoller` | PC2 Task Scheduler, `%LOCALAPPDATA%\muse-wake-poller` | every 5 min, 24/7 (`config.json` can narrow it) | `Get-ScheduledTaskInfo MusePilot-WakePoller`; `poller.log` |
| PC2 worker `MuseOps-PC2Worker` | PC2 Task Scheduler, `%LOCALAPPDATA%\muse-ops-worker` | every 10 min, 24/7; ≤6 runs/day; one task per run; one idle check/day | `worker.log`, `runs\*.json` |
| Muse (PM/QA) | Muse's own scheduler | about every 9–15 min | board activity |

## Recovery behaviour
| Failure | What happens |
|---|---|
| PC2 restart | Logon trigger polls at sign-in; `StartWhenAvailable` runs a missed poll as soon as possible. |
| Poll crashes | Task Scheduler restarts it up to 3 times, 5 min apart (`RestartCount 3`, `PT5M`). |
| Two polls at once | Impossible: `MultipleInstances IgnoreNew` + the poller's atomic lock directory (stale after 9 min). |
| Wake fails | 429 retried ≤3 times after `Retry-After`; timeouts/5xx marked `UNCERTAIN` and never retried (no duplicate sessions); 4xx `FAILED`. The hourly run still catches the task. |
| Runaway API use | Poller: ≤3 wake attempts per rolling hour, one task in flight (90 min). Worker: ≤6 runs/day, ≥20 min apart, 60 min kill, per-run budget cap, a task retried ≤3× (6 h apart), one idle check/day. Engineer routine: one run/hour. |
| PC2 offline | Cloud engineer is PC-independent: hourly polls + FAILOVER rule 3c (pilot-repo harness tasks with no harness post after 2 h). PC2-local work (PeptideFacts, MM sites) waits for PC2; the verifier's HEARTBEAT check reports it. |
| Interrupted run / context limit | Each worker run is a fresh session for one task; the instructions require an IN PROGRESS checkpoint post (done / next / where state lives) before ending unfinished, and the next run resumes from it. |
| Auth expires | Crosswalk key (poller/worker pre-check) → BOARD_READ_FAILED / CHECK_FAILED in the logs, no wakes; routine token → FAILED wakes in poller.log; Claude sign-in → worker runs exit with error in runs\*.json. All surface as stalled tasks in the verifier's daily HEARTBEAT check. Fix = owner re-signs in; nothing retries in a loop. |
| Engineer silent / task stalled | Muse posts WAKE_FAILED/STALLED report flags for Pilot Harness; the verifier's HEARTBEAT check lists stalled tasks daily. |
| Routine run fails | No auto-retry by design; the next hourly run picks the task up again (routine reads the last 2 days of the board). |

## Pause / stop (only on the owner's word)
- Pause poller: `tools\wake-poller\uninstall-task.ps1 -Disable`; resume: `Enable-ScheduledTask MusePilot-WakePoller`.
- Pause routines: RemoteTrigger `update` with `{"enabled": false}` (or claude.ai/code/routines).
- Full teardown: `uninstall-task.ps1 -RemoveCredentials`, delete the routine API token, revoke the `Wake Poller (PC2 script)` Crosswalk key, disable both routines.

## Hours
Default is all day. To narrow: `config.json` in either home → `"windowStart": "08:05", "windowEnd": "22:05"`.

## Optional end date
`%LOCALAPPDATA%\muse-wake-poller\config.json` → `"pilotEnd": "YYYY-MM-DD"` (Eastern). Default is none.
