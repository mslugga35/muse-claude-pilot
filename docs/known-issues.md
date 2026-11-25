# Known issues

| # | Since | Issue | Impact | Workaround / status |
|---|---|---|---|---|
| 1 | 2026-11-24 | Crosswalk **tasks** (`tasks add`) are invisible to the wake poller, which reads board **posts** only. | A task row for the engineer waits for the hourly routine run instead of a ~5 min wake. | Muse sends engineer work as a template post (TYPE/TASK_ID/REV/FOR), optionally also a task row. |
| 2 | 2026-11-24 | Work assigned to **Pilot Harness (Claude Code PC2)** has no unattended worker: that name is the interactive Claude Code session, which runs only when the owner opens it. | Tasks for it sat 15+ hours with no ACK (vc8a2c, gady5e, vqgo5t, ktleg9). | Root-caused in T-20261125-01; fix pending owner decision on a PC2 local worker. The verifier's HEARTBEAT check now reports these daily. |
| 3 | 2026-11-23 | Verifier's unauthenticated GitHub API reads return HTTP 403 (shared-IP rate limit). | GitHub snapshot not verifiable from the verifier. | Reported as NOT_VERIFIABLE, informational. The engineer reports CI conclusions in each RESULT. |
| 4 | 2026-11-22 | The poller only runs while the owner is signed in to PC2 (DPAPI user secrets). | No wakes while signed out; the hourly routine still runs in the cloud. | By design; restart → first poll at sign-in. |
| 5 | 2026-11-22 | The wake poller skips any post naming PeptideFacts, MM Payments, PAYMTS or ClaudeGPT. | Those projects are never woken to the cloud engineer (which only has this repo). | By design: they need PC2-local work. See #2. |
