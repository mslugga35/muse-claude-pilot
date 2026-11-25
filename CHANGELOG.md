# Changelog


## 2026-11-25 — dynamic workload (PR #11)
- Fixed 6 runs/day removed (owner: "dont worry about the limit and work if i hit the limit i hit the limit").
- Worker reads the subscription's live usage from each run (stream-json `rate_limit_event`): pauses on refusal until the reset, resumes itself; never runs while paid extra usage is on.
- A task past 2 runs/day yields to other ready tasks but is never stopped when alone. Runaway fuse 40/day. Gap 10 min.
- usage-summary.json adds inactivity minutes per reason, long idle periods and the latest usage reading.
- Owner reserve: task runs stop at 85% of the weekly limit, released to 92% (last 24 h) and 97% (last 6 h) before the reset; one daily report run continues while paused; real weekly percentages in the daily report; stale-high readings refreshed by a tiny probe; no reading = safe 6/day fallback.

## 2026-11-25 — T-20261125-04: worker scheduling and memory hygiene (PR #11)
- Priority lanes (DEPLOY → this repo → other projects), fair order, max 2 runs per task per day, 45-min run limit.
- Skip runs below 1.5 GB free memory; stop the run's own leftover processes after each run.
- Daily cap unchanged at 6 (owner).

## 2026-11-25 — T-20261125-03: PR #10 merged (e521e60), poller + worker reinstalled from main, verified

## 2026-11-25 — T-20261125-02 + OPERATING MODEL v2: continuous operation
- All-day defaults: poller and PC2 worker windows 00:00–23:59 ET; engineer routine hourly 24/7.
- Worker: ≤6 runs/day, one idle QUEUE EMPTY check per day when nothing is open.
- Engineer routine FAILOVER rule: takes stalled pilot-repo harness tasks when PC2 is down.
- docs/engineering-notes/T-20261125-02.md: failure map, failover options, owner decisions.
- Worker free board pre-check (no LLM run when a task awaits review / is held / the cloud engineer has it); trusts
  only Crosswalk numbers + the owner account; RELEASED ends a hold; new feedback triggers an immediate run.
- `test/line-endings.test.js` (CRLF / control-character guard), `docs/lessons.md`, `docs/owner-communication-rule.md`.

## 2026-11-25 — T-20261125-01: permanent operation
- No end date anywhere: engineer and verifier routine crons, poller `pilotEnd` (now `null`), scheduler EndBoundary.
- Poller task: restart on failure (3× / 5 min). Install script no longer sets an end date.
- New `tools/pc2-worker`: capped headless Claude Code worker for board tasks assigned to the harness.
- Verifier prompt v4: CHECK 2 matches owner flag routing; new heartbeat/stalled-task check; no owner pages.
- New docs: `docs/engineering-notes/`, `docs/known-issues.md`, `docs/runbooks/operations.md`.

## 2026-11-24 — T-20261123-12: PIVEX gate-check wakes (PR #9)
## 2026-11-23 — T-20261123-10: wake poller live on PC2 (PR #7)
