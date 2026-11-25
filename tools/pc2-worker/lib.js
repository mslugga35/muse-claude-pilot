// PC2 worker: pure decision logic (no I/O), so every rule is unit-tested.
// The worker starts ONE headless Claude Code run for ONE open board task assigned to the harness, under hard caps.
import { inWakeWindow, wallClock } from '../wake-poller/lib.js';

export const WORKER_DEFAULTS = Object.freeze({
  timeZone: 'America/New_York',
  windowStart: '08:05',
  windowEnd: '22:05',
  harnessNames: ['pilot harness (claude code pc2)', 'claude', 'claude code', 'pilot harness'],
  // Only tasks created from the owner's own account count (Crosswalk marks them by: 'you'; Muse and the owner both post
  // from it). A task added by any other board member is never worked, whatever it is addressed to.
  trustedBy: ['you'],
  trustedVia: ['muse', 'owner', 'mpmmorales', ''],
  maxRunsPerDay: 6, // runs started per Eastern calendar day
  minGapMinutes: 20, // between run starts
  retryAfterHours: 6, // a task the worker already attempted is not attempted again for this long
  maxAttemptsPerTask: 3, // then it is left for Muse/owner with the evidence already on the board
  runTimeoutMinutes: 60, // the claude process is killed after this
  maxBudgetUsd: 8, // passed to claude --max-budget-usd
});

const MIN = 60 * 1000;

/** Open tasks addressed to the harness, oldest first. */
export function harnessTasks(openRows, cfg = WORKER_DEFAULTS) {
  return (openRows || [])
    .filter((t) => t && t.status === 'open' && typeof t.id === 'string' && /^\w{2,20}$/.test(t.id))
    .filter((t) => cfg.harnessNames.includes(String(t.for || '').trim().toLowerCase()))
    .filter((t) => cfg.trustedBy.includes(String(t.by || '').trim().toLowerCase()))
    .filter((t) => cfg.trustedVia.includes(String(t.via || '').trim().toLowerCase()))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/** Runs started on the same Eastern date as now. */
export function runsToday(state, now, cfg = WORKER_DEFAULTS) {
  const today = wallClock(now, cfg.timeZone).date;
  return (state.runs || []).filter((r) => wallClock(new Date(r.startedAt), cfg.timeZone).date === today).length;
}

/**
 * Decide whether to start a run now, and for which task.
 * state: { runs: [{ taskId, startedAt, endedAt?, outcome? }], attempts: { [taskId]: { count, lastAt } } }
 * running: true when a previous worker run is still alive (lock held).
 */
export function decideRun({ now, openRows, state, running, paused, cfg = WORKER_DEFAULTS }) {
  if (paused) return { action: 'SKIP', reason: 'PAUSED' };
  if (!inWakeWindow(now, cfg)) return { action: 'SKIP', reason: 'OUT_OF_WINDOW' };
  if (running) return { action: 'SKIP', reason: 'RUN_IN_PROGRESS' };
  const tasks = harnessTasks(openRows, cfg);
  if (tasks.length === 0) return { action: 'SKIP', reason: 'NO_HARNESS_TASKS' };
  if (runsToday(state, now, cfg) >= cfg.maxRunsPerDay) return { action: 'SKIP', reason: 'DAILY_CAP' };
  const last = (state.runs || []).reduce((m, r) => Math.max(m, Date.parse(r.startedAt) || 0), 0);
  if (last && now - last < cfg.minGapMinutes * MIN) return { action: 'SKIP', reason: 'MIN_GAP' };
  const attempts = state.attempts || {};
  const pick = tasks.find((t) => {
    const a = attempts[t.id];
    if (!a) return true;
    if (a.count >= cfg.maxAttemptsPerTask) return false;
    return now - Date.parse(a.lastAt) >= cfg.retryAfterHours * 60 * MIN;
  });
  if (!pick) return { action: 'SKIP', reason: 'ALL_ATTEMPTED_RECENTLY', open: tasks.length };
  return { action: 'RUN', taskId: pick.id, title: String(pick.title || '').slice(0, 200), open: tasks.length };
}

/** Record a run start in state (pure: returns a new state). */
export function recordStart(state, taskId, now) {
  const attempts = { ...(state.attempts || {}) };
  const prev = attempts[taskId] || { count: 0 };
  attempts[taskId] = { count: prev.count + 1, lastAt: now.toISOString() };
  const runs = [...(state.runs || []), { taskId, startedAt: now.toISOString() }].slice(-200);
  return { ...state, runs, attempts };
}

/** The only text the headless run is given about the task: ids only, never board content. */
export function runPrompt(taskId) {
  if (!/^\w{2,20}$/.test(taskId)) throw new Error('bad task id');
  return `WORKER RUN. Your assigned board task id is ${taskId} on crosswalk museclaudepilot. ` +
    'Follow the worker instructions you were given. Work on this one task only, then end.';
}
