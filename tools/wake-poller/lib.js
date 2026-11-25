// Pure logic for the Crosswalk wake poller: time window, cron, board classification, wake decisions.
// No I/O here, so every rule is unit-tested (test/*.test.js). No secrets are ever handled in this file.

export const DEFAULTS = Object.freeze({
  crosswalk: 'museclaudepilot',
  crosswalkUrl: 'https://mcp.crosswalk.to',
  pollerAgent: 'Wake Poller (PC2 script)',
  repo: 'mslugga35/muse-claude-pilot',
  routineId: 'trig_01LMfSREdryexCsAJYhHCrY4',
  anthropicVersion: '2023-06-01',
  anthropicBeta: 'experimental-cc-routine-2026-04-01',
  // Who may assign work (post identity) and who the engineer is, by Crosswalk number.
  taskPosterNumbers: ['1111-0507-5348-4228'], // Muse
  engineerNumbers: ['1111-9707-8156-4735'], // CC Engineer (Claude routine)
  engineerAliases: ['cc engineer', 'cc engineer (claude routine)', 'claude-code', 'claude code', 'engineer', 'claude'],
  // Any of these in a task body means another project: never wake for it.
  forbiddenMarkers: ['peptidefacts', 'pf-release', 'mm-payments', 'mm payments', 'mmpayments', 'paymts',
    'getpaymts', 'getmmpayments', 'paymtswebsite', 'claudegpt'],
  // A Muse task post whose brief starts with this prefix is a Pivex gate check: eligible without the REPO line
  // (T-20261123-12). Every other rule (poster, template, FOR, forbidden projects, other repos, paths) still applies.
  pivexPrefix: 'PIVEX:',
  timeZone: 'America/New_York',
  // Continuous operation (owner 2026-11-25): all day. Spend is bounded by maxWakesPerHour and one task in flight.
  windowStart: '00:00', // inclusive, Eastern wall clock
  windowEnd: '23:59', // inclusive
  // Permanent operation since 2026-11-25 (T-20261125-01): no end date. Set pilotEnd to an Eastern date (YYYY-MM-DD)
  // in config.json to make the poller stop waking after that day.
  pilotEnd: null,
  hourlyCron: '5 * * * *', // the routine's schedule (UTC), used only to avoid collisions; PC2 config.json sets the live value
  deferBeforeMin: 5, // hourly run starts within this many minutes -> defer, recheck next poll
  deferAfterMin: 7, // ...and keep deferring until the hourly run has had this long to ACK
  maxWakesPerHour: 3, // successful + uncertain wake attempts in any rolling 60 minutes
  inflightMinutes: 90, // a woken-but-unfinished task blocks the next wake this long (one task at a time)
  lookbackDays: 2,
  maxRateLimitRetries: 3, // only for HTTP 429, which provably created no session
  fireTimeoutMs: 30000,
});

const MIN = 60 * 1000;

// ---------- Eastern time ----------
export function wallClock(date, timeZone = DEFAULTS.timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')),
    hhmm: `${get('hour')}:${get('minute')}` };
}

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function inWakeWindow(date, cfg = DEFAULTS) {
  const { minutes } = wallClock(date, cfg.timeZone);
  return minutes >= toMinutes(cfg.windowStart) && minutes <= toMinutes(cfg.windowEnd);
}

export function pilotEnded(date, cfg = DEFAULTS) {
  if (!cfg.pilotEnd) return false; // no end date configured: permanent operation
  return wallClock(date, cfg.timeZone).date > cfg.pilotEnd;
}

// ---------- cron (UTC, 5 fields: minute hour day-of-month month day-of-week) ----------
function fieldMatches(spec, value) {
  return spec.split(',').some((part) => {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo; let hi;
    if (range === '*') { lo = -Infinity; hi = Infinity; } else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); } else { lo = hi = Number(range); }
    if (value < lo || value > hi) return false;
    return range === '*' ? value % step === 0 : (value - lo) % step === 0;
  });
}

export function cronMatches(cron, date) {
  const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
  return fieldMatches(mi, date.getUTCMinutes()) && fieldMatches(h, date.getUTCHours())
    && fieldMatches(dom, date.getUTCDate()) && fieldMatches(mon, date.getUTCMonth() + 1) && fieldMatches(dow, date.getUTCDay());
}

/** The hourly run fire time inside [now - after, now + before], or null. */
export function nearbyScheduledRun(now, cfg = DEFAULTS) {
  const base = Math.floor(now.getTime() / MIN) * MIN;
  for (let k = -cfg.deferAfterMin; k <= cfg.deferBeforeMin; k += 1) {
    const t = new Date(base + k * MIN);
    if (cronMatches(cfg.hourlyCron, t)) return t;
  }
  return null;
}

// ---------- Crosswalk "when" strings, e.g. "Sat, Nov 21, 6:51pm EST" ----------
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseWhen(when, now) {
  const m = /^\w{3}, (\w{3}) (\d{1,2}),(?: (\d{4}),)? (\d{1,2}):(\d{2})(am|pm) (EST|EDT)$/.exec(String(when || '').trim());
  if (!m) return null;
  const [, mon, day, yearStr, hh, mm, ampm, zone] = m;
  let hour = Number(hh) % 12; if (ampm === 'pm') hour += 12;
  const offset = zone === 'EDT' ? 4 : 5;
  const build = (y) => new Date(Date.UTC(y, MONTHS[mon], Number(day), hour + offset, Number(mm)));
  if (yearStr) return build(Number(yearStr));
  const year = Number(wallClock(now).date.slice(0, 4));
  const d = build(year);
  return d.getTime() > now.getTime() + 2 * 24 * 60 * MIN ? build(year - 1) : d;
}

// ---------- board classification ----------
const ENGINEER_REPLY = /^\[CC\]\s+(ACK|PONG|RESULT)\s+(T-\d{8}-\d{2})\/rev(\d+)/i;
const NOT_A_TASK = /^(\[MUSE\]\s*)?(\[?REVIEW|\[?STALLED|\[?WAKE_FAILED|CLARIFICATION|PLANNING|\[VERIFY|\[CC\])/i;
const TASK_ID = /T-\d{8}-\d{2}/;

/** Engineer progress per WORK KEY: { 'T-x/rev0': { ack: Date|null, result: Date|null } } */
export function engineerProgress(rows, now, cfg = DEFAULTS) {
  const out = {};
  for (const r of rows) {
    if (!cfg.engineerNumbers.includes(r.via_number)) continue; // by number only: a display name can be copied
    const m = ENGINEER_REPLY.exec(r.brief || '');
    if (!m) continue;
    const key = `${m[2]}/rev${Number(m[3])}`;
    const at = parseWhen(r.when, now)
      || (Number.isFinite(r.age_days) ? new Date(now.getTime() - r.age_days * 24 * 60 * MIN) : new Date(0));
    out[key] ||= { ack: null, result: null };
    if (/ACK/i.test(m[1])) out[key].ack = out[key].ack && out[key].ack < at ? out[key].ack : at;
    else out[key].result = at; // PONG or RESULT both close the item
  }
  return out;
}

/** Rows worth opening: posted by an authorized task poster, mention a task id, not a review/stall/etc. */
export function taskCandidates(rows, cfg = DEFAULTS) {
  return rows.filter((r) => cfg.taskPosterNumbers.includes(r.via_number)
    && TASK_ID.test(r.brief || '') && !NOT_A_TASK.test((r.brief || '').trim()));
}

/** The text of an `open` result for ONE id: valid only if it is that post's block (first header names the id). */
export function openedBlock(text, id) {
  const first = /^--- post #(\w+) /m.exec(String(text || ''));
  if (!first || first[1] !== id) return null;
  return text;
}

function header(block, name) {
  const m = new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'mi').exec(block);
  return m ? m[1] : null;
}

/**
 * Decide whether one opened task post may be woken. Returns
 * { verdict: 'ELIGIBLE', workKey, taskId, rev, type } or { verdict: 'SKIP_*', reason, workKey? }.
 */
export function classifyTask(row, block, cfg = DEFAULTS) {
  if (!cfg.taskPosterNumbers.includes(row.via_number)) return { verdict: 'SKIP_POSTER', reason: `poster ${row.via || '?'} not authorized` };
  const type = (header(block, 'TYPE') || '').toUpperCase();
  const taskId = header(block, 'TASK_ID');
  const revRaw = header(block, 'REV');
  const forWho = (header(block, 'FOR') || row.for || '').trim().toLowerCase();
  const repo = (header(block, 'REPO') || '').replace(/[.,;:)]+$/, '') || null;
  if (!['TASK', 'REVISION', 'PING'].includes(type)) return { verdict: 'SKIP_NOT_TASK', reason: `TYPE ${type || 'missing'}` };
  if (!taskId || !/^T-\d{8}-\d{2}$/.test(taskId)) return { verdict: 'SKIP_NOT_TASK', reason: 'TASK_ID missing or malformed' };
  if (type === 'REVISION' && revRaw === null) return { verdict: 'SKIP_NOT_TASK', reason: 'REVISION without REV' };
  const rev = revRaw === null ? 0 : Number(revRaw);
  if (!Number.isInteger(rev) || rev < 0) return { verdict: 'SKIP_NOT_TASK', reason: 'REV malformed' };
  const workKey = `${taskId}/rev${rev}`;
  if (!cfg.engineerAliases.includes(forWho)) return { verdict: 'SKIP_NOT_FOR_ENGINEER', reason: `FOR ${forWho || 'missing'}`, workKey };
  const kind = cfg.pivexPrefix && String(row.brief || '').trim().toUpperCase().startsWith(cfg.pivexPrefix.toUpperCase()) ? 'PIVEX' : 'REPO';
  if (!repo && kind !== 'PIVEX') return { verdict: 'SKIP_NO_REPO', reason: 'no REPO line naming the authorized repo', workKey };
  if (repo && repo.toLowerCase() !== cfg.repo.toLowerCase()) return { verdict: 'SKIP_UNAUTHORIZED_REPO', reason: `REPO ${repo}`, workKey };
  const lower = block.toLowerCase();
  const marker = cfg.forbiddenMarkers.find((w) => lower.includes(w));
  if (marker) return { verdict: 'SKIP_UNAUTHORIZED_PROJECT', reason: `mentions ${marker}`, workKey };
  if (/\b[a-z]:\\/i.test(block)) return { verdict: 'SKIP_UNAUTHORIZED_PROJECT', reason: 'mentions a local Windows path', workKey };
  const otherRepo = [...block.matchAll(/(?:github\.com\/)?\b(mslugga35|mslugga|mpmmo)\/([\w.-]+)/gi)]
    .map((x) => `${x[1]}/${x[2].replace(/[.-]+$/, '')}`.toLowerCase()).find((r) => r !== cfg.repo.toLowerCase());
  if (otherRepo) return { verdict: 'SKIP_UNAUTHORIZED_REPO', reason: `mentions ${otherRepo}`, workKey };
  return { verdict: 'ELIGIBLE', workKey, taskId, rev, type, kind };
}

// ---------- decisions ----------
export const COUNTED = new Set(['WOKEN', 'UNCERTAIN', 'SENDING']);

export function wakesInLastHour(state, now) {
  return (state.wakes || []).filter((w) => COUNTED.has(w.status) && now - new Date(w.at) < 60 * MIN).length;
}

/** A task still being worked blocks the next wake (one task at a time). Returns the blocking work key or null. */
export function inflight(state, progress, now, cfg = DEFAULTS) {
  const limit = cfg.inflightMinutes * MIN;
  for (const [key, t] of Object.entries(state.tasks || {})) {
    const w = t.wake;
    if (!w || !COUNTED.has(w.status)) continue;
    const p = progress[key];
    if (p && p.result) continue;
    if (now - new Date(w.attemptedAt) < limit) return key;
  }
  for (const [key, p] of Object.entries(progress)) {
    if (p.ack && !p.result && now - p.ack < limit) return key;
  }
  return null;
}

/**
 * Choose what this poll does. eligible = [{ workKey, postId, poster, postedAt }], oldest first.
 * Returns { action: 'WAKE'|'DEFER'|'HOLD_INFLIGHT'|'RATE_CAPPED'|'NOTHING', task?, reason }.
 */
export function decide({ now, eligible, state, progress, cfg = DEFAULTS }) {
  const open = [];
  for (const e of eligible) {
    const p = progress[e.workKey];
    if (p && (p.ack || p.result)) continue; // engineer already has it
    const t = state.tasks?.[e.workKey];
    const w = t?.wake;
    if (w && w.status !== 'RATE_LIMITED') continue; // woken, uncertain, sending or failed: never again
    if (w && w.status === 'RATE_LIMITED') {
      if ((w.attempts || 0) >= cfg.maxRateLimitRetries) continue;
      if (w.retryAfter && now < new Date(w.retryAfter)) continue;
    }
    open.push(e);
  }
  if (!open.length) return { action: 'NOTHING', reason: 'no un-ACKed eligible task' };
  const task = open[0];
  const blocking = inflight(state, progress, now, cfg);
  if (blocking) return { action: 'HOLD_INFLIGHT', task, reason: `${blocking} still in progress` };
  if (wakesInLastHour(state, now) >= cfg.maxWakesPerHour) return { action: 'RATE_CAPPED', task, reason: `${cfg.maxWakesPerHour} wakes in the last hour` };
  // Hourly run about to start or still booting: defer and recheck for its ACK each poll; wake only once it has had
  // deferAfterMin minutes to ACK and still hasn't (a booting session can't be seen any other way).
  const run = nearbyScheduledRun(now, cfg);
  if (run) return { action: 'DEFER', task, reason: `hourly run at ${run.toISOString()}; recheck for ACK next poll` };
  const deferred = state.tasks?.[task.workKey]?.deferredAt;
  return { action: 'WAKE', task, reason: deferred ? 'hourly run did not ACK it' : 'eligible' };
}

/** Map a fire response to a wake status. Only HTTP 429 is retryable: it provably created no session. */
export function classifyFire({ status, error }) {
  if (error) return 'UNCERTAIN'; // timeout or network error: the request may have created a session
  if (status >= 200 && status < 300) return 'WOKEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'FAILED'; // 400/401/403/404: rejected, no session, needs a human
  return 'UNCERTAIN'; // 5xx
}

export function wakeText(task, cfg = DEFAULTS) {
  // Only validated identifiers go into the payload: no post text, so nothing a poster wrote reaches the session here.
  if (!/^\w{2,20}$/.test(task.postId) || !/^T-\d{8}-\d{2}\/rev\d+$/.test(task.workKey)) throw new Error('invalid task reference');
  return [
    'routine-fire-payload (Wake Poller on PC2). WAKE for exactly one item.',
    `crosswalk: ${cfg.crosswalk}`,
    `post id: ${task.postId}`,
    `WORK KEY: ${task.workKey}`,
    ...(task.kind === 'PIVEX' ? ['KIND: PIVEX gate check (read-only: no branch, no PR, no repo writes, never touch orders).'] : []),
    `Open post ${task.postId} and handle only WORK KEY ${task.workKey} under your normal triage (check for an existing [CC] ACK first).`,
    'Do not select a different task in this run. If it is already ACKed, end with DUPLICATE_SKIP.',
  ].join('\n');
}

/** Strip anything token-shaped before it can reach a log line. */
export function redact(value) {
  return String(value)
    .replace(/sk-ant-[\w-]+/g, 'sk-ant-[REDACTED]')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}
