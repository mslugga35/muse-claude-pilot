# Crosswalk wake poller (PC2)

Wakes the engineer routine within minutes of a new task, instead of waiting up to an hour for its next scheduled run.
The hourly routine stays unchanged and acts as the fallback.

Every 5 minutes, Windows Task Scheduler runs one poll:

1. Outside **08:05–22:05 America/New_York** (DST-aware), or after **2026-11-27**: logs the poll and does nothing else,
   without reading the board.
2. Reads the last 2 days of the `museclaudepilot` board with a **read-only key that can only see that board**
   (`peek`, so nothing is marked read).
3. A post is a task candidate only if **Muse posted it** (checked by Crosswalk number) and its body has
   `TYPE: TASK|REVISION|PING`, `TASK_ID`, `REV`, `FOR: CC Engineer`, and **`REPO: mslugga35/muse-claude-pilot`**.
   It is skipped and logged if:
   - the `REPO:` line is missing or names another repo;
   - the body names another repo;
   - the body contains a local Windows path;
   - the body names PeptideFacts, MM Payments, PAYMTS or ClaudeGPT.
4. Deduplication uses the work key `TASK_ID/revN`, recorded with the post id and the poster's number. A REVISION
   (rev N+1) is new work. A task the engineer has already ACKed is never woken.
5. When it finds a task:
   - **Hourly run about to start or still starting up** (5 minutes before to 7 minutes after the routine's `:05` run):
     defers and rechecks for the hourly run's ACK at each poll. If it still has no ACK once that run has had 7 minutes, the poller fires the wake (a session that is still booting can't be seen any other way).
   - **One task at a time**: while a woken or ACKed task has no RESULT (up to 90 minutes), the next task waits.
   - **Rate cap**: at most **3** successful or uncertain wake attempts in any rolling hour.
6. A wake is one `POST /v1/claude_code/routines/<id>/fire`. Its `text` names the exact post id and work key, and tells
   the engineer not to pick a different task. The fire API has no idempotency key, so retries could create duplicate
   sessions:
   - The attempt is written to the history file **before** the request is sent.
   - A timeout, network error, 5xx, or a crash mid-send is marked `UNCERTAIN` and **never retried**. The hourly run
     still catches the task.
   - 400/401/403/404 are marked `FAILED` and not retried.
   - Only 429 (no session created) is retried, after `Retry-After`, up to 3 times.

The poller only reads Crosswalk and fires the trigger. It never posts, edits, merges, deploys or touches a repo.
It does no alerting either: Muse's own checks flag missing ACKs.

## Files

| Where | What |
|---|---|
| `tools/wake-poller/` (repo) | `lib.js` rules, `poller.js` one poll, `*.ps1` Windows glue, `test/` (runs in `npm test`) |
| `%LOCALAPPDATA%\muse-wake-poller\app\` | Installed copy that Task Scheduler runs (so switching git branches can't break it) |
| `%LOCALAPPDATA%\muse-wake-poller\creds\` | 2 DPAPI-encrypted files (current Windows user only, folder ACL limited to you + SYSTEM) |
| `%LOCALAPPDATA%\muse-wake-poller\poller.log` | **Log**: one JSON line per poll, task decision and wake (timestamps in UTC + ET); rotates at 5 MB |
| `%LOCALAPPDATA%\muse-wake-poller\state.json` | Persistent wake history + dedup state + cached task verdicts |
| `%LOCALAPPDATA%\muse-wake-poller\config.json` | Optional non-secret overrides of `DEFAULTS` in `lib.js` (refused if it contains a key/token) |

No credential is in the repo, in a command line, in the log, or in a config file. `run-poller.ps1` decrypts both
credentials into environment variables of its own process only, for the length of one poll.

## Install: one step

In your own PowerShell window on PC2:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\mslug\muse-claude-pilot\tools\wake-poller\setup.ps1
```

1. It opens the two pages where you create the credentials:
   - **Routine token**: routine *muse-claude-pilot engineer (Crosswalk wake)* → Edit → Trigger **+** → **API** →
     **Generate token**. It is shown once.
   - **Crosswalk key**: name `Wake Poller (PC2 script)`, scope **read only**, rooms **museclaudepilot only**.
2. It asks for each credential with hidden input and stores both DPAPI-encrypted for your Windows user
   (`set-credentials.ps1`).
3. It checks the key can read the board (`run-poller.ps1 -Check`), then does a dry run that fires nothing and changes
   nothing (`-DryRun`).
4. It installs the task (`install-task.ps1`). The task is `MusePilot-WakePoller`:
   - It runs every 5 minutes, plus once at sign-in after a restart.
   - It skips a run if the previous one is still going, and stops any run after 9 minutes.
   - It needs no admin rights.
   - It runs only while you're signed in. DPAPI user secrets can't be decrypted by a stored-password-free background
     logon, and storing your Windows password in the task would be a bigger exposure.
   - It expires on its own at 2026-11-28 00:00 ET.

`install-task.ps1 -Validate` registers a disabled copy under another name, prints what Windows stored, and deletes it.
It was verified on PC2 on 2026-11-22: interval PT5M, no repeat limit, EndBoundary 2026-11-28T00:00-05:00, Interactive
logon, Limited run level, IgnoreNew, PT9M time limit.

## Pre-install evidence (2026-11-22, no credentials)

| Test | Result |
|---|---|
| `npm test` (CI and local) | 67/67 |
| `install-task.ps1 -Validate` on PC2 | Disabled copy registered, read back as above, removed |
| Real endpoint, invalid key (`--check`) | `CHECK_FAILED`, fixed error text in the log, nothing fired |
| Routine honors the wake reference | Manual fire naming done post `zum62g` / `T-20261120-05/rev0`: engineer opened only that post, `DUPLICATE_SKIP`, no posts, 8 s (session `cse_01XrRUkDZFHwGhn7Qwcumb4f`) |

## Check, disable, remove

```powershell
Get-ScheduledTaskInfo MusePilot-WakePoller             # last/next run, last result
Get-Content "$env:LOCALAPPDATA\muse-wake-poller\poller.log" -Tail 20
.\uninstall-task.ps1 -Disable                           # pause (keeps it installed)
Enable-ScheduledTask MusePilot-WakePoller               # resume
.\uninstall-task.ps1 -RemoveCredentials                 # remove task + app copy + local credential files
```

## Teardown (pilot end, 2026-11-27): also in ops/SCORECARD.md

1. `.\uninstall-task.ps1 -RemoveCredentials`. Verify with `Get-ScheduledTask MusePilot-WakePoller` (should return no
   task).
2. Revoke the routine token: routine → Edit → API trigger → **Delete token**. Verify that the routine's
   `api_token_hint` is empty.
3. Revoke the Crosswalk key `Wake Poller (PC2 script)` at crosswalk.to/keys. Verify that `account keys` no longer
   lists it.
4. Keep `poller.log` and `state.json` as evidence.

## Tests

`npm test` covers:
- the ET window edges, midnight, and both DST switches;
- the pilot end date;
- deferral around the hourly run;
- duplicates, reposts and revisions;
- one task at a time and the rolling-hour cap;
- API outcomes (200, 401, 429, 500, timeout, crash mid-send);
- overlapping and concurrent polls;
- PeptideFacts and MM Payments tasks, and other repos;
- secrets never written to the log or state.
