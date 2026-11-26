# T-20261125-06: PC2 worker safeguards without the 6-run cap (board task hs4egt)

| Field | Value |
|---|---|
| Project | muse-claude-pilot (tools/pc2-worker) |
| Completed | 2026-11-26 ET |
| Board task / posts | task `hs4egt`; ACK `bg4sug`; GAP TABLE `vcx5gv`; RESULT see board |
| Muse review | pending |
| Commits / PR | branch `claude/T-20261125-06-worker-safeguards` (PR to main) |
| Deployment | not deployed (DEPLOY task per rule cf6vg2 after Muse APPROVE) |

Note: the id T-20261125-06 is also used by the closed Supabase-plan task (`docs/engineering-notes/T-20261125-06.md`), hence this file name.

## Requirement
Owner (2026-11-25): safeguards against excessive usage, repeated failures and duplicate tasks without the six-run daily cap; smallest change, no new infrastructure, never enable paid usage.

## Root cause
Gap check of main ce7ca5f (table on the board, post `vcx5gv`): usage gates, run timeout, lock and runaway fuse already existed. Missing: a hard per-task daily ceiling, failure-aware retry (attempts counted every run, not failures; flat 6 h delay; nothing marked a task blocked), a cross-task circuit breaker, a same-title duplicate check, and any owner-visible alert (the worker has a read-only key and never posts).

## Solution
`tools/pc2-worker/lib.js` (pure logic) and `worker.js` (state/log only):
- G1 `hardMaxRunsPerTaskPerDay` 6: a task is not picked past it, even with fresh feedback; skip reason `TASK_DAILY_CEILING`.
- G2 `maxConsecutiveFailures` 3: failed runs in a row (`EXITED_ERROR`, `KILLED_TIMEOUT`, `SPAWN_FAILED`, `NO_PROMPT_FILE`, or no outcome after timeout+10 min) block the task; logged once as `TASK_BLOCKED`, stored in `state.blocked`. New Muse/owner feedback unblocks it.
- G3 backoff: retry delay `6 h x 2^(failures-1)` (6 h, 12 h) after failures.
- G4 `circuitFailures` 5 / `circuitCooldownMinutes` 180: five failed runs in a row across tasks pause the worker (`CIRCUIT_OPEN`), then one probe run; success closes it, failure re-opens it. Idle checks do not count.
- G5 `dropDuplicateTitles`: of open tasks with the same normalized title only the oldest is worked. TASK_IDs are deliberately not compared (they repeat across tasks).
- G6 `usage-summary.json` gains `alerts` {fuseHit, circuitOpened, taskDailyCeilingHit, blockedTasks}; the daily usage post can quote it.

## Files, functions, APIs, integrations changed
lib.js: `WORKER_DEFAULTS`, `consecutiveFailures`, `circuitState`, `dropDuplicateTitles`, `alertsFor`, `usageSummary`, `decideRun`. worker.js: `trackBlocked`, skip logging. Tests: `tools/pc2-worker/test/worker.test.js`.

## Database / configuration / infrastructure changes (before → after)
None outside the repo. No new credential, no board writes from the worker, no scheduled task change. New defaults are overridable in the worker's config.json like the others.

## Decisions and reasoning
- Board "BLOCKED" post from the worker was not added: it needs a write key (new credential = owner decision). The blocked state is logged and surfaced through usage-summary.json instead.
- Not a work cap: ceilings only bite on failure loops or one task taking 6+ runs a day.
- Claim/lease on Crosswalk not added for the same credential reason; local lock + board checks (CC_HAS_IT, IN_PROGRESS_ELSEWHERE) remain.
- Idempotency keys for posts live in worker-prompt.md on PC2 (not in the repo): NOT_VERIFIABLE here, unchanged.

## Tests (exact commands and results)
`npm test` on main before the change: 102 pass / 0 fail. After: 110 pass / 0 fail. Each new rule has a falsifier assertion (same scenario with the safeguard set to off/Infinity must change the result): G1, G2, G4, G5 explicit; G3 asserts both sides of each delay; G6 asserts true and false.

## Rollback
Revert the PR commit, reinstall worker from main (`tools/pc2-worker/install-worker.ps1`). state.json keeps working (extra `blocked` key is ignored by the old code).

## Known limitations / remaining work
Blocked state is rewritten only on skip checks, so a stale entry can persist until the next skip. The board cannot show BLOCKED automatically until the worker has a write credential.

## Lessons learned
Count failures, not attempts: attempts include runs that made progress.
