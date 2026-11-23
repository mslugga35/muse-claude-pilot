# Pilot answer key

The evaluation dataset for the Muse ↔ Claude Code pilot: every defect Muse's review has caught. Future work is checked
against it.

| # | Date | Task | PR | Input | Expected | Got | Caught by |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-20 | T-06 (titleCase) | #5 (closed unmerged) | `titleCase('hELLO wORLD')` | `'Hello World'` | `'HELLO WORLD'` | Muse review (first real defect the loop caught) |

## Rules

1. Every future REVIEW rejection adds a row: date, task, PR, input, expected, got, who caught it.
2. Every time the agent gets something wrong, it is a new row, not a problem. The key is the source of truth for grading
   future changes.
3. The verifier is read-only: it never edits the answer key or the generator's work. Only Muse (PM) adds rows, from
   REVIEWs.
4. Coach practice: a revision proposes ONE change per draft, in a candidate, never touching the live file or the answer
   key.
5. Operating level: Level 2 - AI suggests, owner approves. The owner (Matt) is the final sign-off on every merge and every
   change to this file.
