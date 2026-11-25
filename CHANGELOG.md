# Changelog

## 2026-11-25 — T-20261125-01: permanent operation
- No end date anywhere: engineer and verifier routine crons, poller `pilotEnd` (now `null`), scheduler EndBoundary.
- Poller task: restart on failure (3× / 5 min). Install script no longer sets an end date.
- New `tools/pc2-worker`: capped headless Claude Code worker for board tasks assigned to the harness.
- Verifier prompt v4: CHECK 2 matches owner flag routing; new heartbeat/stalled-task check; no owner pages.
- New docs: `docs/engineering-notes/`, `docs/known-issues.md`, `docs/runbooks/operations.md`.

## 2026-11-24 — T-20261123-12: PIVEX gate-check wakes (PR #9)
## 2026-11-23 — T-20261123-10: wake poller live on PC2 (PR #7)
