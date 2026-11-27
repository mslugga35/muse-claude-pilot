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
  // Work whenever there is work (owner 2026-11-25, T-20261125-05: "dont worry about the limit and work if i hit the
  // limit i hit the limit"). No fixed daily cap. When the subscription refuses calls, the worker pauses until the reset
  // time Claude Code reports, then resumes on its own. It never runs while paid extra usage is on (OVERAGE_GUARD).
  fuseRunsPerDay: 40, // runaway fuse (a loop bug), not a work target: real runs take 15-45 min each
  idleCheckPerDay: true, // with no open harness task: at most ONE short run per day (QUEUE EMPTY + next known item)
  minGapMinutes: 10, // between run starts (= the scheduler interval: back-to-back when there is work)
  retryAfterHours: 6, // a task the worker already attempted is not attempted again for this long
  maxAttemptsPerTask: 3, // then it is left for Muse/owner with the evidence already on the board
  runTimeoutMinutes: 45, // the claude process is killed after this (was 60: one run held the only lane for an hour)
  maxRunsPerTaskPerDay: 2, // fairness: past this, a task yields to any other ready task (it is not a stop: alone, it runs)
  minFreeMemoryMB: 1500, // below this, skip the run (LOW_MEMORY) instead of risking a failed run or slowing other apps
  maxBudgetUsd: 8, // passed to claude --max-budget-usd
  // T-20261125-06 safeguards (owner: usage, repeated failures, duplicates). None of these is a work target.
  hardMaxRunsPerTaskPerDay: 6, // G1: one task never takes more than this many runs a day, even with fresh feedback
  maxConsecutiveFailures: 3, // G2: a task whose last N runs all failed is BLOCKED (left alone) until new feedback arrives
  circuitFailures: 5, // G4: this many failed runs in a row across tasks open the breaker
  circuitCooldownMinutes: 180, // G4: breaker pause, then ONE probe run; a success closes it, a failure re-opens it
});

const MIN = 60 * 1000;

// A run that crashed the worker leaves no outcome; after the run timeout (+10 min lock margin) it counts as failed.
const FAILED = new Set(['EXITED_ERROR', 'KILLED_TIMEOUT', 'SPAWN_FAILED', 'NO_PROMPT_FILE']);
const runFailed = (r, now, cfg) => (r.outcome ? FAILED.has(r.outcome) : now - Date.parse(r.startedAt) > (cfg.runTimeoutMinutes + 10) * MIN);
const runEnd = (r) => Date.parse(r.endedAt || r.startedAt) || 0;

/** Failed runs in a row for one task (newest first), stopping at the first run that did not fail. */
export function consecutiveFailures(state, taskId, now = new Date(), cfg = WORKER_DEFAULTS) {
  let n = 0;
  const runs = (state.runs || []).filter((r) => r.taskId === taskId);
  for (let i = runs.length - 1; i >= 0 && runFailed(runs[i], now, cfg); i -= 1) n += 1;
  return n;
}

/** Circuit breaker: { open, until } when the last circuitFailures runs (any task) all failed and the cooldown has not passed. */
export function circuitState(state, now, cfg = WORKER_DEFAULTS) {
  const runs = (state.runs || []).filter((r) => r.taskId !== 'IDLE');
  const tail = runs.slice(-cfg.circuitFailures);
  if (!(cfg.circuitFailures > 0) || tail.length < cfg.circuitFailures || !tail.every((r) => runFailed(r, now, cfg))) return { open: false };
  const until = runEnd(tail[tail.length - 1]) + cfg.circuitCooldownMinutes * MIN;
  return now < until ? { open: true, until: new Date(until).toISOString() } : { open: false };
}

/** Open tasks addressed to the harness, oldest first. */
export function harnessTasks(openRows, cfg = WORKER_DEFAULTS) {
  return (openRows || [])
    .filter((t) => t && t.status === 'open' && typeof t.id === 'string' && /^\w{2,20}$/.test(t.id))
    .filter((t) => cfg.harnessNames.includes(String(t.for || '').trim().toLowerCase()))
    .filter((t) => cfg.trustedBy.includes(String(t.by || '').trim().toLowerCase()))
    .filter((t) => cfg.trustedVia.includes(String(t.via || '').trim().toLowerCase()))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/** G5: of several open tasks with the same title, only the oldest is worked (list is oldest first). TASK_IDs are NOT compared: they can repeat across distinct tasks. */
export function dropDuplicateTitles(tasks) {
  const seen = new Set();
  return tasks.filter((t) => { const k = String(t.title || '').trim().toLowerCase().replace(/\s+/g, ' '); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
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
    const at = parseWhen(h.when, now);
    if (!at || now - at < 2 * 3600 * 1000) return 'IN_PROGRESS_ELSEWHERE';
  }
  return null;
}

/** Latest time anyone other than the harness posted about the task (owner account only), or null. */
export function lastFeedbackAt(task, rows, now) {
  const keys = taskKeys(task);
  for (const r of rows || []) { // newest first
    if (!fromOwnerAccount(r) || isHarness(r) || !mentions(r, keys)) continue;
    const at = parseWhen(r.when, now);
    if (at) return at;
  }
  return null;
}

/** Per-day usage summary for the owner's daily report (no LLM): runs, minutes, list-price equivalent, outcomes. */
export function usageSummary(state, date, cfg = WORKER_DEFAULTS) {
  const runs = (state.runs || []).filter((r) => wallClock(new Date(r.startedAt), cfg.timeZone).date === date);
  const sum = (k) => runs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const byTask = {};
  for (const r of runs) byTask[r.taskId] = (byTask[r.taskId] || 0) + 1;
  return {
    date, runs: runs.length, fuse: cfg.fuseRunsPerDay, minutes: Math.round(sum('seconds') / 60),
    listPriceUsd: Math.round(sum('costUsd') * 100) / 100, turns: sum('turns'), permissionDenials: sum('denials'),
    byTask, outcomes: runs.reduce((a, r) => { a[r.outcome || 'RUNNING'] = (a[r.outcome || 'RUNNING'] || 0) + 1; return a; }, {}),
    note: 'list-price equivalent as reported by Claude Code; billed against the owner subscription, not dollars',
    inactivity: inactivitySummary(state, date, cfg), latestUsageReading: state.limits || null,
    alerts: alertsFor(state, date, cfg),
  };
}

/** Owner-visible safeguard hits for one Eastern date (the worker has a read-only key, so the daily usage post quotes these). */
export function alertsFor(state, date, cfg = WORKER_DEFAULTS) {
  const reasons = (state.periods || []).filter((p) => wallClock(new Date(p.from), cfg.timeZone).date === date).map((p) => p.reason);
  const hit = (r) => reasons.includes(r);
  return {
    fuseHit: hit('FUSE'), circuitOpened: hit('CIRCUIT_OPEN'), taskDailyCeilingHit: hit('TASK_DAILY_CEILING'),
    blockedTasks: Object.entries(state.blocked || {}).map(([id, b]) => ({ id, since: b.since, failures: b.failures })),
  };
}

// ---- Subscription usage (T-20261125-05) ----
/**
 * Parse Claude Code stream-json output (one JSON object per line) into the latest usage reading, or null.
 * Uses only the rate_limit_event lines: { status, resetsAt (unix s), rateLimitType, utilization (0..1),
 * unifiedWindows: { seven_day|five_hour: { utilization, resetsAt, status } }, overageEnabled, isUsingOverage }.
 */
export function readingFromStream(text, observedAt = new Date()) {
  let ev = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.includes('"rate_limit_event"')) continue;
    try { const o = JSON.parse(line); if (o.type === 'rate_limit_event' && o.rate_limit_info) ev = o.rate_limit_info; } catch { /* partial line */ }
  }
  if (!ev) return null;
  const windows = {};
  const put = (name, w) => {
    if (!w || !Number.isFinite(Number(w.utilization))) return;
    windows[name] = { utilization: Number(w.utilization), resetsAt: Number(w.resetsAt) * 1000 || null, status: String(w.status || '') };
  };
  for (const [name, w] of Object.entries(ev.unifiedWindows || {})) put(name, w);
  if (ev.rateLimitType && !windows[ev.rateLimitType]) put(ev.rateLimitType, ev);
  return {
    observedAt: new Date(observedAt).toISOString(), status: String(ev.status || ''), resetsAt: Number(ev.resetsAt) * 1000 || null,
    windows, overageEnabled: ev.overageEnabled === true, isUsingOverage: ev.isUsingOverage === true,
  };
}

/**
 * Gate from the latest usage reading (taken from the previous run's own output; no extra calls). Returns null (go)
 * or a skip { reason, until? }:
 *  OVERAGE_GUARD: paid extra usage is on or in use. Owner rule: never spend it without approval, so no runs.
 *  LIMIT_PAUSE: the subscription refused calls; resume automatically after the reported reset time.
 */
export function usageGate(reading, now) {
  if (!reading) return null;
  if (reading.overageEnabled || reading.isUsingOverage) return { reason: 'OVERAGE_GUARD' };
  const refusals = [{ status: reading.status, resetsAt: reading.resetsAt }, ...Object.values(reading.windows || {})];
  for (const w of refusals) {
    if (/rejected/.test(String(w.status || '')) && w.resetsAt && now < w.resetsAt) return { reason: 'LIMIT_PAUSE', until: new Date(w.resetsAt).toISOString() };
  }
  return null;
}

// ---- Inactivity accounting (for the daily report) ----
/** Extend the open inactivity period if the reason is unchanged (checks are ~10 min apart), else start a new one. */
export function recordSkip(state, reason, now) {
  const periods = [...(state.periods || [])];
  const last = periods[periods.length - 1];
  const iso = now.toISOString();
  if (last && last.reason === reason && now - Date.parse(last.to) <= 25 * MIN) periods[periods.length - 1] = { ...last, to: iso };
  else periods.push({ reason, from: iso, to: iso });
  return { ...state, periods: periods.slice(-400) };
}

/** Minutes per inactivity reason on an Eastern date, plus the periods of 30 min or more. */
export function inactivitySummary(state, date, cfg = WORKER_DEFAULTS) {
  const byReason = {}; const long = [];
  for (const p of state.periods || []) {
    if (wallClock(new Date(p.from), cfg.timeZone).date !== date) continue;
    const mins = Math.max(10, Math.round((Date.parse(p.to) - Date.parse(p.from)) / MIN) + 10); // each check covers ~10 min
    byReason[p.reason] = (byReason[p.reason] || 0) + mins;
    if (mins >= 30) long.push({ reason: p.reason, from: p.from, to: p.to, minutes: mins });
  }
  return { minutesByReason: byReason, periods: long.slice(-30) };
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
export function decideRun({ now, openRows, state, running, paused, boardRows = null, freeMemoryMB = Infinity, cfg = WORKER_DEFAULTS }) {
  const gate = usageGate(state.limits, now);
  if (gate) return { action: 'SKIP', ...gate };
  if (paused) return { action: 'SKIP', reason: 'PAUSED' };
  if (!inWakeWindow(now, cfg)) return { action: 'SKIP', reason: 'OUT_OF_WINDOW' };
  if (running) return { action: 'SKIP', reason: 'RUN_IN_PROGRESS' };
  const circuit = circuitState(state, now, cfg);
  if (circuit.open) return { action: 'SKIP', reason: 'CIRCUIT_OPEN', until: circuit.until };
  const all = dropDuplicateTitles(harnessTasks(openRows, cfg));
  const skipped = boardRows ? all.map((t) => [t.id, boardSkip(t, boardRows, now)]).filter(([, r]) => r) : [];
  const tasks = all.filter((t) => !skipped.some(([id]) => id === t.id));
  if (all.length && !tasks.length) return { action: 'SKIP', reason: 'ALL_WAITING_ON_OTHERS', waiting: Object.fromEntries(skipped) };
  if (runsToday(state, now, cfg) >= cfg.fuseRunsPerDay) return { action: 'SKIP', reason: tasks.length ? 'FUSE' : 'NO_HARNESS_TASKS' };
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
  const blocked = {};
  // Fairness: never-attempted tasks first, then the one attempted longest ago (a busy old task must not starve a new one,
  // e.g. a DEPLOY task waiting behind a long review thread). Ties keep oldest-created first.
  const lastAt = (t) => (attempts[t.id] ? Date.parse(attempts[t.id].lastAt) : -Infinity);
  const today = wallClock(now, cfg.timeZone).date;
  const runsTodayFor = (id) => (state.runs || []).filter((r) => r.taskId === id && wallClock(new Date(r.startedAt), cfg.timeZone).date === today).length;
  // Priority lanes: DEPLOY tasks first (finishing approved work), then operation infrastructure (this repo), then the
  // rest; inside a lane, never-attempted first, then least recently attempted.
  const lane = (t) => (/\bDEPLOY\b/.test(String(t.title || '')) ? 0 : /REPO:\s*mslugga35\/muse-claude-pilot/.test(String(t.details || '')) ? 1 : 2);
  // Fairness, not a stop: a task past maxRunsPerTaskPerDay goes behind every task under it, but still runs if nothing
  // else is ready.
  const over = (t) => (runsTodayFor(t.id) >= cfg.maxRunsPerTaskPerDay ? 1 : 0);
  const ordered = [...tasks].sort((x, y) => over(x) - over(y) || lane(x) - lane(y) || lastAt(x) - lastAt(y));
  const pick = ordered.find((t) => {
    if (runsTodayFor(t.id) >= cfg.hardMaxRunsPerTaskPerDay) return false; // G1
    const a = attempts[t.id];
    if (!a) return true;
    // New feedback (a review, revision or answer) since the last attempt makes the task workable now: that is progress,
    // not a retry, so it neither waits for retryAfterHours nor counts toward maxAttemptsPerTask.
    const fb = boardRows ? lastFeedbackAt(t, boardRows, now) : null;
    if (fb && fb > Date.parse(a.lastAt)) return true;
    const fails = consecutiveFailures(state, t.id, now, cfg);
    if (fails >= cfg.maxConsecutiveFailures) { blocked[t.id] = { failures: fails }; return false; } // G2
    if (a.count >= cfg.maxAttemptsPerTask) return false;
    // G3: exponential backoff after failures (6 h, 12 h, ...); a run that did not fail keeps the plain retry delay
    return now - Date.parse(a.lastAt) >= cfg.retryAfterHours * 60 * MIN * 2 ** Math.max(0, fails - 1);
  });
  if (!pick) {
    const ceiling = tasks.length && tasks.every((t) => runsTodayFor(t.id) >= cfg.hardMaxRunsPerTaskPerDay);
    return { action: 'SKIP', reason: ceiling ? 'TASK_DAILY_CEILING' : 'ALL_ATTEMPTED_RECENTLY', open: tasks.length, blocked: Object.keys(blocked).length ? blocked : undefined };
  }
  if (freeMemoryMB < cfg.minFreeMemoryMB) return { action: 'SKIP', reason: 'LOW_MEMORY', freeMemoryMB: Math.round(freeMemoryMB) };
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

/**
 * Board watches: a session asks the worker to look out for a post (for example Muse's PASS/FAIL on a release) so no
 * session has to stay open polling. watches.json = [{ id, match: [terms], since, expires }]. A post counts only if a
 * task poster wrote it (Muse, checked by Crosswalk number; a display name can be copied), it was posted after "since"
 * (so an older post that mentions the task, such as the assignment itself, never counts) and its brief contains a term.
 */
export function activeWatches(list, now) {
  if (!Array.isArray(list)) return [];
  return list.filter((w) => w && /^[\w.-]{1,60}$/.test(w.id || '') && Date.parse(w.expires) > +now
    && Date.parse(w.since) > 0 && Date.parse(w.since) <= +now
    && Array.isArray(w.match) && w.match.length > 0 && w.match.length <= 10
    && w.match.every((t) => typeof t === 'string' && t.length >= 6 && t.length <= 80));
}

/**
 * New hits only: each (watch, post) pair is reported once. seen is updated in place as each hit is emitted, so a post
 * listed twice in one read is still one hit. A post whose time can't be parsed is skipped (fail closed: a false
 * "verdict" is worse than a later one). Brief is capped; it is data, not instructions.
 */
export function watchHits(watches, rows, seen = {}, posterNumbers = POLLER.taskPosterNumbers, now = new Date(), stats = {}) {
  stats.unparseable = 0; stats.unparseableSamples = [];
  const hits = [];
  for (const w of watches) {
    const terms = w.match.map((t) => t.toLowerCase());
    const since = Math.floor(Date.parse(w.since) / 60000) * 60000;
    for (const r of rows || []) {
      if (!r || !/^\w{2,20}$/.test(r.id || '') || !posterNumbers.includes(r.via_number)) continue;
      const brief = String(r.brief || '');
      if (!terms.some((t) => brief.toLowerCase().includes(t))) continue;
      const at = parseWhen(r.when, now);
      if (!at) { stats.unparseable += 1; if (stats.unparseableSamples.length < 3) stats.unparseableSamples.push({ postId: r.id, when: String(r.when ?? "").slice(0, 60) }); continue; } // counted so a board format change is visible in the log
      if (+at < since) continue;
      const k = `${w.id}:${r.id}`;
      if (seen[k]) continue;
      seen[k] = now.toISOString();
      hits.push({ watchId: w.id, postId: r.id, brief: brief.slice(0, 300), postedAt: at.toISOString() });
    }
  }
  return hits;
}

/** Board read window for watches, in days: back to the oldest "since", at least 1, at most 3 (a longer read risks the
 * 5-page truncation on a busy board, which would fail every check). */
export function watchWindowDays(watches, now) {
  const oldest = Math.min(...watches.map((w) => Date.parse(w.since)));
  return Math.min(3, Math.max(1, Math.ceil((+now - oldest) / 86400000)));
}
