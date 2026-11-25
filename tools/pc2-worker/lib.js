// PC2 worker: pure decision logic (no I/O), so every rule is unit-tested.
// The worker starts ONE headless Claude Code run for ONE open board task assigned to the harness, under hard caps.
import { inWakeWindow, wallClock, parseWhen, DEFAULTS as POLLER } from '../wake-poller/lib.js';

export const WORKER_DEFAULTS = Object.freeze({
  timeZone: 'America/New_York',
  // Continuous operation (owner 2026-11-25, OPERATING MODEL v2): all day, every day. Spend is bounded by the caps below.
  windowStart: '00:00',
  windowEnd: '23:59',
  harnessNames: ['pilot harness (claude code pc2)', 'claude', 'claude code', 'pilot harness'],
  // Only tasks created from the owner's own account count (Crosswalk marks them by: 'you'; Muse and the owner both post
  // from it). A task added by any other board member is never worked, whatever it is addressed to.
  trustedBy: ['you'],
  trustedVia: ['muse', 'owner', 'mpmmorales', ''],
  maxRunsPerDay: 6, // runs started per Eastern calendar day (task runs + the idle check); task-spec value (T-20261125-01)
  idleCheckPerDay: true, // with no open harness task: at most ONE short run per day (QUEUE EMPTY + next known item)
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

/** Task id plus any TASK_ID (T-YYYYMMDD-NN) in its title or details: the strings posts use to refer to it. */
export function taskKeys(task) {
  const keys = new Set([task.id]);
  for (const m of `${task.title || ''} ${task.details || ''}`.matchAll(/T-\d{8}-\d{2}/g)) { keys.add(m[0]); break; }
  return [...keys];
}

// Identity by Crosswalk number, never by display name or brief text (security review 2026-11-25).
export const HARNESS_NUMBERS = ['1111-8527-2703-8497'];
const fromOwnerAccount = (r) => String(r.author || '').toLowerCase() === 'you';
const isHarness = (r) => HARNESS_NUMBERS.includes(String(r.via_number || ''));
const isCcAck = (r) => (POLLER.engineerNumbers || []).includes(String(r.via_number || '')) && /^\[CC\] ACK\b/.test(String(r.brief || ''));
// Keys are task ids (\w+) or TASK_IDs (T-\d{8}-\d{2}), so they hold no regex specials; still reject anything else.
const safeKey = (k) => (/^[\w-]+$/.test(k) ? k : null);
const mentions = (r, keys) => keys.some((k) => safeKey(k) && new RegExp(`(^|[^\\w-])${k}($|[^\\w-])`).test(String(r.brief || '')));

/**
 * Free board check BEFORE any LLM run (rows = museclaudepilot posts, newest first, as the board returns them).
 * Returns a skip reason, or null when the task really needs a run.
 *  - CC_HAS_IT: the cloud engineer ACKed it (failover).
 *  - IN_PROGRESS_ELSEWHERE: the latest harness post is IN PROGRESS / RECEIVED and under 2 h old (another session has it).
 *  - AWAITING_REVIEW: the latest harness post is READY FOR REVIEW / BLOCKED / RESULT / DONE and nobody else has posted
 *    about the task since (no review, revision or answer yet).
 */
export function boardSkip(task, rows, now) {
  const keys = taskKeys(task);
  // Only posts from the owner's own account (Muse, the harness, the cloud engineer, the owner) count.
  const related = (rows || []).filter((r) => fromOwnerAccount(r) && mentions(r, keys));
  if (related.some(isCcAck)) return 'CC_HAS_IT';
  const iHarness = related.findIndex(isHarness);
  if (iHarness === -1) return null;
  const h = related[iHarness];
  const newerFromOthers = related.slice(0, iHarness).some((r) => !isHarness(r));
  if (newerFromOthers) return null; // Muse (or the owner) answered: there is new work
  const brief = String(h.brief || '');
  if (/READY FOR REVIEW|BLOCKED|RESULT|\bDONE\b/.test(brief)) return 'AWAITING_REVIEW';
  if (/RELEASED/.test(brief)) return null; // another session handed the task back explicitly
  if (/IN PROGRESS|RECEIVED/.test(brief)) {
    const at = parseWhen(String(h.when || '').replace(/^(Today|Yesterday), /, ''), now);
    if (!at || now - at < 2 * 3600 * 1000) return 'IN_PROGRESS_ELSEWHERE';
  }
  return null;
}

/** Latest time anyone other than the harness posted about the task (owner account only), or null. */
export function lastFeedbackAt(task, rows, now) {
  const keys = taskKeys(task);
  for (const r of rows || []) { // newest first
    if (!fromOwnerAccount(r) || isHarness(r) || !mentions(r, keys)) continue;
    const at = parseWhen(String(r.when || '').replace(/^(Today|Yesterday), /, ''), now);
    if (at) return at;
  }
  return null;
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
export function decideRun({ now, openRows, state, running, paused, boardRows = null, cfg = WORKER_DEFAULTS }) {
  if (paused) return { action: 'SKIP', reason: 'PAUSED' };
  if (!inWakeWindow(now, cfg)) return { action: 'SKIP', reason: 'OUT_OF_WINDOW' };
  if (running) return { action: 'SKIP', reason: 'RUN_IN_PROGRESS' };
  const all = harnessTasks(openRows, cfg);
  const skipped = boardRows ? all.map((t) => [t.id, boardSkip(t, boardRows, now)]).filter(([, r]) => r) : [];
  const tasks = all.filter((t) => !skipped.some(([id]) => id === t.id));
  if (all.length && !tasks.length) return { action: 'SKIP', reason: 'ALL_WAITING_ON_OTHERS', waiting: Object.fromEntries(skipped) };
  if (runsToday(state, now, cfg) >= cfg.maxRunsPerDay) return { action: 'SKIP', reason: tasks.length ? 'DAILY_CAP' : 'NO_HARNESS_TASKS' };
  const last = (state.runs || []).reduce((m, r) => Math.max(m, Date.parse(r.startedAt) || 0), 0);
  if (last && now - last < cfg.minGapMinutes * MIN) return { action: 'SKIP', reason: tasks.length ? 'MIN_GAP' : 'NO_HARNESS_TASKS' };
  if (tasks.length === 0) {
    // Low-cost monitoring: one idle check per Eastern day, never more, and only after 08:00 ET so it lands in the
    // owner's day. Everything else about an empty queue is Muse's discovery job.
    const today = wallClock(now, cfg.timeZone);
    const idleToday = (state.runs || []).some((r) => r.taskId === 'IDLE' && wallClock(new Date(r.startedAt), cfg.timeZone).date === today.date);
    if (cfg.idleCheckPerDay && !idleToday && today.minutes >= 8 * 60) return { action: 'RUN', taskId: 'IDLE', title: 'idle check', open: 0 };
    return { action: 'SKIP', reason: 'NO_HARNESS_TASKS' };
  }
  const attempts = state.attempts || {};
  // Fairness: never-attempted tasks first, then the one attempted longest ago (a busy old task must not starve a new one,
  // e.g. a DEPLOY task waiting behind a long review thread). Ties keep oldest-created first.
  const lastAt = (t) => (attempts[t.id] ? Date.parse(attempts[t.id].lastAt) : -Infinity);
  const ordered = [...tasks].sort((x, y) => lastAt(x) - lastAt(y));
  const pick = ordered.find((t) => {
    const a = attempts[t.id];
    if (!a) return true;
    // New feedback (a review, revision or answer) since the last attempt makes the task workable now: that is progress,
    // not a retry, so it neither waits for retryAfterHours nor counts toward maxAttemptsPerTask.
    const fb = boardRows ? lastFeedbackAt(t, boardRows, now) : null;
    if (fb && fb > Date.parse(a.lastAt)) return true;
    if (a.count >= cfg.maxAttemptsPerTask) return false;
    return now - Date.parse(a.lastAt) >= cfg.retryAfterHours * 60 * MIN;
  });
  if (!pick) return { action: 'SKIP', reason: 'ALL_ATTEMPTED_RECENTLY', open: tasks.length };
  return { action: 'RUN', taskId: pick.id, title: String(pick.title || '').slice(0, 200), open: tasks.length };
}

/** Record a run start in state (pure: returns a new state). */
export function recordStart(state, taskId, now) {
  if (taskId === 'IDLE') return { ...state, runs: [...(state.runs || []), { taskId, startedAt: now.toISOString() }].slice(-200) };
  const attempts = { ...(state.attempts || {}) };
  const prev = attempts[taskId] || { count: 0 };
  // (a run started because of new feedback still records lastAt, so the same feedback never triggers twice)
  attempts[taskId] = { count: prev.count + 1, lastAt: now.toISOString() };
  const runs = [...(state.runs || []), { taskId, startedAt: now.toISOString() }].slice(-200);
  return { ...state, runs, attempts };
}

/** The only text the headless run is given about the task: ids only, never board content. */
export function runPrompt(taskId) {
  if (taskId === 'IDLE') {
    return 'WORKER IDLE CHECK. No board task is open for you on crosswalk museclaudepilot. Follow the IDLE section of ' +
      'the worker instructions you were given (one short QUEUE EMPTY post at most), then end.';
  }
  if (!/^\w{2,20}$/.test(taskId)) throw new Error('bad task id');
  return `WORKER RUN. Your assigned board task id is ${taskId} on crosswalk museclaudepilot. ` +
    'Follow the worker instructions you were given. Work on this one task only, then end.';
}
