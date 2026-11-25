# Lessons learned (muse-claude-pilot operation)

Each lesson: what went wrong, root cause, and the rule, test or workflow change that prevents it. Read before starting
work. Project-specific lessons for other repos live in those repos.

| # | Date | What happened | Root cause | Prevention (now in place) |
|---|---|---|---|---|
| L-001 | 2026-11-24, 11-25 | Whole files showed as changed; diffs unreadable | Python text-mode writes on Windows produce CRLF | `test/line-endings.test.js` fails on CRLF; edit with LF-safe tools (`newline=''` in Python, or sed) |
| L-002 | 2026-11-25 | A regex silently never matched (`[CC] ACK` skip) | `"\b"` inside a non-raw Python string became a backspace byte | Same test file rejects control characters in source; use raw strings for regex text |
| L-003 | 2026-11-25 | Muse rejected work citing missing authorization | Owner decisions given in Claude's chat are invisible to Muse | Quote the owner's exact words in the RESULT and the note whenever a chat decision is relied on |
| L-004 | 2026-11-24 | Tasks sat 15–20 h with no ACK | Muse assigned work to a name (Pilot Harness) with no unattended worker | PC2 worker + verifier HEARTBEAT check; every assignable name must map to something that runs on its own |
| L-005 | 2026-11-24 | A test task never woke the engineer | Crosswalk task rows are not board posts; the poller reads posts | known-issues #1; engineer work is sent as a template post |
| L-006 | 2026-11-25 | Muse flagged a raised cap (6 → 10) as scope creep | A value was changed without an owner-stated number | Change limits only to owner-stated values; otherwise keep the task-spec value |
| L-007 | 2026-11-25 | The worker would have re-run tasks waiting on review (LLM cost, no progress) | Retry logic ignored board state | Free board pre-check (`boardSkip`): AWAITING_REVIEW / IN_PROGRESS_ELSEWHERE / CC_HAS_IT skip without an LLM run, with tests |
| L-008 | 2026-11-25 | "Not responding" overnight looked like an outage | An 08:05–22:05 window by design | Check schedules first; windows are now all-day by default |
| L-009 | 2026-11-25 | Security review: a fake `[CC] ACK` from any board member could make the worker skip a task | Board posts were trusted by brief text / display name | `boardSkip` trusts only the owner account and Crosswalk numbers, exact id match; test 'board check trusts Crosswalk numbers…' |
| L-010 | 2026-11-25 | Worker respected an interactive 2-h hold after the interactive session was done; a review posted after an attempt would have waited 6 h | Holds could not be released; retry delay ignored new feedback | `[HARNESS] RELEASED` ends a hold; new feedback since the last attempt makes a task workable immediately (not a retry); tests in worker.test.js |
| L-011 | 2026-11-25 | Approved work never got merged | The approval closed the task; the worker only works open tasks | Rule `cf6vg2`: approval that authorizes a deploy comes with a separate DEPLOY task, closed only on VERIFIED |
| L-012 | 2026-11-25 | One task used 4 of 6 daily runs; DEPLOY task starved | Oldest-first ordering + every review post re-qualifies the task | Priority lanes, least-recently-attempted order, max 2 runs per task per day (PR #11, tests) |
| L-013 | 2026-11-25 | A claim post held 3 tasks instead of 1 | The free board check treats any harness post that mentions a task id as about that task | Claim / IN PROGRESS posts name only the task they hold |
| L-014 | 2026-11-25 | Preview servers left running after worker runs | Runs start servers and exit without stopping them | Worker stops the run's own descendant processes after each run (`cleanupDescendants`, live-tested) |
| L-015 | 2026-11-25 | A regex `/?
/` became real CR/LF bytes; JS failed to parse | Shell heredoc + Python string escapes, and Python text-mode reads turn CRLF into LF (a byte-exact fix failed) | Write scripts to a file with the Write tool; byte fixes use `newline=''`; `node --check` before tests |
