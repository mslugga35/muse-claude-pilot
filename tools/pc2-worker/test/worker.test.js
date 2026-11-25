import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// Tests must not depend on how much memory the machine running them has free (PC2 is often low): pin it.
os.freemem = () => 8 * 1024 ** 3;
import { WORKER_DEFAULTS as D, harnessTasks, decideRun, recordStart, runsToday, runPrompt, readingFromStream, usageGate, recordSkip, inactivitySummary } from '../lib.js';
import { checkOnce } from '../worker.js';

const T = (s) => new Date(s);
const NOON = T('2026-11-25T17:00:00Z'); // 12:00 ET
const task = (id, extra = {}) => ({ id, status: 'open', by: 'you', via: 'Muse', for: 'Pilot Harness (Claude Code PC2)', title: `t ${id}`,
  created_at: '2026-11-24T10:00:00Z', ...extra });
const empty = () => ({ runs: [], attempts: {} });

test('only open tasks for the harness count, oldest first; ids validated', () => {
  const rows = [task('b2', { created_at: '2026-11-25T01:00:00Z' }), task('a1'), task('c3', { for: 'Muse' }),
    task('d4', { status: 'done' }), task('bad id!'), task('e5', { for: 'claude', created_at: '2026-11-24T11:00:00Z' })];
  assert.deepEqual(harnessTasks(rows).map((t) => t.id), ['a1', 'e5', 'b2']);
});

test('tasks from other board members, or other agents of the account, are never worked', () => {
  const rows = [task('a1', { by: 'stranger' }), task('b2', { via: 'Some Bot' }), task('c3', { by: undefined }), task('d4')];
  assert.deepEqual(harnessTasks(rows).map((t) => t.id), ['d4']);
});

test('skips: paused, outside 08:05-22:05 ET, run in progress, nothing open', () => {
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), paused: true }).reason, 'PAUSED');
  // 24h by default (owner 2026-11-25): 03:00 ET and 22:10 ET both run
  assert.equal(decideRun({ now: T('2026-11-25T08:00:00Z'), openRows: [task('a1')], state: empty() }).action, 'RUN');
  assert.equal(decideRun({ now: T('2026-11-26T03:10:00Z'), openRows: [task('a1')], state: empty() }).action, 'RUN');
  const narrow = { ...D, windowStart: '08:05', windowEnd: '22:05' };
  assert.equal(decideRun({ now: T('2026-11-25T12:00:00Z'), openRows: [task('a1')], state: empty(), cfg: narrow }).reason, 'OUT_OF_WINDOW');
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), running: true }).reason, 'RUN_IN_PROGRESS');
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), running: true }).reason, 'RUN_IN_PROGRESS');
});

test('empty queue: one idle check per Eastern day after 08:00 ET, never more', () => {
  let s = empty();
  const none = [task('c3', { for: 'Muse' })];
  assert.equal(decideRun({ now: T('2026-11-25T11:00:00Z'), openRows: none, state: s }).reason, 'NO_HARNESS_TASKS'); // 06:00 ET
  const d = decideRun({ now: NOON, openRows: none, state: s });
  assert.deepEqual([d.action, d.taskId], ['RUN', 'IDLE']);
  s = recordStart(s, 'IDLE', NOON);
  assert.deepEqual(s.attempts, {}, 'idle runs never count as task attempts');
  assert.equal(decideRun({ now: new Date(+NOON + 3 * 3600000), openRows: none, state: s }).reason, 'NO_HARNESS_TASKS');
  assert.equal(decideRun({ now: T('2026-11-26T14:00:00Z'), openRows: none, state: s }).taskId, 'IDLE'); // next day
  assert.equal(decideRun({ now: NOON, openRows: none, state: empty(), cfg: { ...D, idleCheckPerDay: false } }).reason, 'NO_HARNESS_TASKS');
  assert.match(runPrompt('IDLE'), /IDLE CHECK/);
});

test('runs the oldest task, then respects the gap, the retry delay and the per-task cap', () => {
  let s = empty();
  const rows = [task('a1'), task('b2', { created_at: '2026-11-25T01:00:00Z' })];
  const d1 = decideRun({ now: NOON, openRows: rows, state: s });
  assert.deepEqual([d1.action, d1.taskId], ['RUN', 'a1']);
  s = recordStart(s, 'a1', NOON);
  assert.equal(decideRun({ now: new Date(+NOON + 5 * 60000), openRows: rows, state: s }).reason, 'MIN_GAP');
  const d2 = decideRun({ now: new Date(+NOON + 25 * 60000), openRows: rows, state: s });
  assert.equal(d2.taskId, 'b2'); // a1 attempted < 6 h ago
  s = recordStart(s, 'b2', new Date(+NOON + 25 * 60000));
  assert.equal(decideRun({ now: new Date(+NOON + 60 * 60000), openRows: rows, state: s }).reason, 'ALL_ATTEMPTED_RECENTLY');
  assert.equal(decideRun({ now: new Date(+NOON + 7 * 3600000), openRows: rows, state: s }).taskId, 'a1'); // retry after 6 h
  s.attempts.a1 = { count: D.maxAttemptsPerTask, lastAt: '2026-11-20T00:00:00Z' };
  s.attempts.b2 = { count: D.maxAttemptsPerTask, lastAt: '2026-11-20T00:00:00Z' };
  assert.equal(decideRun({ now: new Date(+NOON + 8 * 3600000), openRows: rows, state: s }).reason, 'ALL_ATTEMPTED_RECENTLY');
});

test('no fixed daily cap: 6+ runs keep going; only the runaway fuse (Eastern date) stops a loop', () => {
  let s = empty();
  for (let i = 0; i < 6; i += 1) s = recordStart(s, `x${i}`, new Date(+T('2026-11-25T13:10:00Z') + i * 30 * 60000));
  assert.equal(decideRun({ now: T('2026-11-25T23:00:00Z'), openRows: [task('a1')], state: s }).action, 'RUN', 'owner: never stop at six');
  for (let i = 6; i < D.fuseRunsPerDay; i += 1) s = recordStart(s, `x${i}`, new Date(+T('2026-11-25T13:10:00Z') + i * 60000));
  assert.equal(runsToday(s, NOON), D.fuseRunsPerDay);
  assert.equal(decideRun({ now: T('2026-11-25T23:00:00Z'), openRows: [task('a1')], state: s }).reason, 'FUSE');
  assert.equal(runsToday(s, T('2026-11-26T14:00:00Z')), 0);
});

test('the run prompt carries the task id only, never board text', () => {
  assert.match(runPrompt('vqgo5t'), /task id is vqgo5t/);
  assert.throws(() => runPrompt('x; rm -rf /'), /bad task id/);
});

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pc2w-')); }
function fakeSpawn(code = 0) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const c = new EventEmitter(); c.kill = () => {};
    setImmediate(() => c.emit('exit', code, null));
    return c;
  };
  return { impl, calls };
}
const env = { CROSSWALK_POLLER_KEY: 'k' };
process.env.CROSSWALK_POLLER_KEY = 'k-from-parent'; // as run-worker.ps1 sets it

test('checkOnce: one run, recorded before start, auto permission mode, budget cap, no shell, lock released', async () => {
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x');
  const sp = fakeSpawn(0);
  const r = await checkOnce({ home: h, now: NOON, env, spawnImpl: sp.impl, readTasks: async () => [task('a1')] });
  assert.equal(r.outcome, 'EXITED_OK');
  assert.equal(sp.calls.length, 1);
  const a = sp.calls[0].args;
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!a.includes('bypassPermissions') && !a.includes('--dangerously-skip-permissions'));
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], String(D.maxBudgetUsd));
  assert.equal(sp.calls[0].opts.shell, false);
  assert.equal(sp.calls[0].opts.env.CROSSWALK_POLLER_KEY, undefined, 'board key not inherited');
  const s = JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8'));
  assert.equal(s.attempts.a1.count, 1);
  assert.equal(s.runs[0].outcome, 'EXITED_OK');
  assert.ok(!fs.existsSync(path.join(h, 'poller.lock')), 'lock released');
  const r2 = await checkOnce({ home: h, now: new Date(+NOON + 60000), env, spawnImpl: sp.impl, readTasks: async () => [task('a1')] });
  assert.equal(r2.outcome, 'MIN_GAP');
  assert.equal(sp.calls.length, 1);
});

test('checkOnce: held lock = no run; PAUSE = no board read; missing key or prompt = no run', async () => {
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x');
  fs.mkdirSync(path.join(h, 'poller.lock'));
  fs.writeFileSync(path.join(h, 'poller.lock', 'owner.json'), JSON.stringify({ token: 'o', at: NOON.toISOString() }));
  const sp = fakeSpawn(0); let reads = 0;
  const rt = async () => { reads += 1; return [task('a1')]; };
  assert.equal((await checkOnce({ home: h, now: NOON, env, spawnImpl: sp.impl, readTasks: rt })).outcome, 'RUN_IN_PROGRESS');
  const h2 = home(); fs.writeFileSync(path.join(h2, 'PAUSE'), '');
  assert.equal((await checkOnce({ home: h2, now: NOON, env, spawnImpl: sp.impl, readTasks: rt })).outcome, 'PAUSED');
  assert.equal((await checkOnce({ home: home(), now: NOON, env: {}, spawnImpl: sp.impl, readTasks: rt })).outcome, 'CONFIG_ERROR');
  assert.equal(reads, 0);
  assert.equal((await checkOnce({ home: home(), now: NOON, env, spawnImpl: sp.impl, readTasks: rt })).outcome, 'NO_PROMPT_FILE');
  assert.equal(sp.calls.length, 0);
});

test('checkOnce: board read failure fails closed; config may not change who counts as the harness', async () => {
  const h = home();
  assert.equal((await checkOnce({ home: h, now: NOON, env, readTasks: async () => { throw new Error('HTTP 500'); } })).outcome, 'BOARD_READ_FAILED');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ harnessNames: ['muse'] }));
  await assert.rejects(checkOnce({ home: h, now: NOON, env, readTasks: async () => [] }), /may not set harnessNames/);
});

test('checkOnce: a timeout kill is reported, not retried at once', async () => {
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x');
  const impl = () => { const c = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('exit', null, 'SIGTERM')); return c; };
  assert.equal((await checkOnce({ home: h, now: NOON, env, spawnImpl: impl, readTasks: async () => [task('a1')] })).outcome, 'KILLED_TIMEOUT');
  assert.equal((await checkOnce({ home: h, now: new Date(+NOON + 30 * 60000), env, spawnImpl: impl, readTasks: async () => [task('a1')] })).outcome, 'ALL_ATTEMPTED_RECENTLY');
});

// ---------- free board pre-check (no LLM run for tasks waiting on someone else) ----------
import { boardSkip, taskKeys } from '../lib.js';
const NUM = { 'Pilot Harness (Claude Code PC2)': '1111-8527-2703-8497', 'CC Engineer (Claude routine)': '1111-9707-8156-4735', Muse: '1111-0507-5348-4228' };
const post = (brief, via, when = 'Today, Wed, Nov 25, 11:50am EST', extra = {}) => ({ brief, via, when, author: 'you', via_number: NUM[via], ...extra });

test('task keys: id plus the TASK_ID from the title or details', () => {
  assert.deepEqual(taskKeys(task('pya3ps', { title: 'T-20261125-01 PRIORITY: remove expirations' })), ['pya3ps', 'T-20261125-01']);
  assert.deepEqual(taskKeys(task('vc8a2c', { title: 'PeptideFacts preview' })), ['vc8a2c']);
});

test('awaiting review: our READY FOR REVIEW / BLOCKED is the latest word, so no run', () => {
  const t = task('vc8a2c', { title: 'PeptideFacts preview' });
  const rows = [post('[HARNESS] BLOCKED vc8a2c — 4 of 5 done', 'Pilot Harness (Claude Code PC2)'),
    post('[HARNESS] RECEIVED vc8a2c', 'Pilot Harness (Claude Code PC2)')];
  assert.equal(boardSkip(t, rows, NOON), 'AWAITING_REVIEW');
  // Muse answers -> new work -> run
  assert.equal(boardSkip(t, [post('REVIEW vc8a2c: NEEDS CHANGES', 'Muse'), ...rows], NOON), null);
});

test('in progress elsewhere for under 2 h, then free again; cloud failover ACK always skips', () => {
  const t = task('jvhe06', { title: 'T-20261125-02: failover' });
  const ip = [post('[HARNESS] IN PROGRESS (interactive session) T-20261125-02 failover', 'Pilot Harness (Claude Code PC2)', 'Today, Wed, Nov 25, 11:30am EST')];
  assert.equal(boardSkip(t, ip, NOON), 'IN_PROGRESS_ELSEWHERE'); // 30 min old
  assert.equal(boardSkip(t, ip, new Date(+NOON + 3 * 3600000)), null); // 3.5 h old: stale claim, take it
  assert.equal(boardSkip(t, [post('[CC] ACK T-20261125-02/rev0 — failover from PC2 worker', 'CC Engineer (Claude routine)')], NOON), 'CC_HAS_IT');
  assert.equal(boardSkip(t, [], NOON), null);
});

test('decideRun uses the board check: waiting tasks are passed over without an LLM run', async () => {
  const rows = [post('[HARNESS] BLOCKED a1 — waiting', 'Pilot Harness (Claude Code PC2)')];
  const d = decideRun({ now: NOON, openRows: [task('a1')], state: empty(), boardRows: rows });
  assert.equal(d.reason, 'ALL_WAITING_ON_OTHERS');
  assert.deepEqual(d.waiting, { a1: 'AWAITING_REVIEW' });
  const d2 = decideRun({ now: NOON, openRows: [task('a1'), task('b2', { created_at: '2026-11-25T01:00:00Z' })], state: empty(), boardRows: rows });
  assert.equal(d2.taskId, 'b2');
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x'); const sp = fakeSpawn(0);
  const r = await checkOnce({ home: h, now: NOON, env, spawnImpl: sp.impl, readTasks: async () => ({ open: [task('a1')], rows }) });
  assert.equal(r.outcome, 'ALL_WAITING_ON_OTHERS');
  assert.equal(sp.calls.length, 0, 'no LLM run');
});

test('board check trusts Crosswalk numbers and the owner account, not names or brief text', () => {
  const t = task('jvhe06', { title: 'T-20261125-02: failover' });
  const fakeAck = post('[CC] ACK T-20261125-02/rev0 — failover', 'CC Engineer (Claude routine)', undefined, { via_number: '9999-0000-0000-0000' });
  assert.equal(boardSkip(t, [fakeAck], NOON), null, 'an ACK from another number is ignored');
  const outsider = post('[CC] ACK T-20261125-02/rev0', 'CC Engineer (Claude routine)', undefined, { author: 'mallory' });
  assert.equal(boardSkip(t, [outsider], NOON), null, 'posts from other accounts are ignored');
  const fakeHarness = post('[HARNESS] READY FOR REVIEW T-20261125-02', 'Pilot Harness (Claude Code PC2)', undefined, { via_number: '1234-5678-9012-3456' });
  assert.equal(boardSkip(t, [fakeHarness], NOON), null, 'a [HARNESS] brief from another number is not ours');
  // exact id match: T-20261125-021 or xjvhe06 do not mention T-20261125-02 / jvhe06
  assert.equal(boardSkip(t, [post('[HARNESS] READY FOR REVIEW T-20261125-021', 'Pilot Harness (Claude Code PC2)')], NOON), null);
  assert.equal(boardSkip(t, [post('[HARNESS] BLOCKED xjvhe06', 'Pilot Harness (Claude Code PC2)')], NOON), null);
});

test('new feedback since the last attempt makes a task workable at once; the same feedback never triggers twice', () => {
  const t = task('a1', { title: 'T-20261125-77 thing' });
  let s = recordStart(empty(), 'a1', T('2026-11-25T15:00:00Z')); // attempted 10:00 ET
  const review = post('REVIEW T-20261125-77: NEEDS CHANGES', 'Muse', 'Today, Wed, Nov 25, 11:30am EST');
  const d = decideRun({ now: NOON, openRows: [t], state: s, boardRows: [review] });
  assert.equal(d.taskId, 'a1', 'review at 11:30 is newer than the 10:00 attempt');
  s = recordStart(s, 'a1', NOON);
  assert.equal(decideRun({ now: new Date(+NOON + 30 * 60000), openRows: [t], state: s, boardRows: [review], cfg: { ...D, maxRunsPerTaskPerDay: 9 } }).reason, 'ALL_ATTEMPTED_RECENTLY');
});

test('an explicit RELEASED post ends a hold by another session', () => {
  const t = task('jvhe06', { title: 'T-20261125-02: failover' });
  const rows = [post('[HARNESS] RELEASED T-20261125-02 to the PC2 worker', 'Pilot Harness (Claude Code PC2)'),
    post('[HARNESS] IN PROGRESS (interactive session) T-20261125-02', 'Pilot Harness (Claude Code PC2)')];
  assert.equal(boardSkip(t, rows, NOON), null);
});

test('fairness: a never-attempted task goes before an old task that keeps getting feedback', () => {
  const old = task('a1', { title: 'T-20261124-99 old busy task' });
  const fresh = task('d9', { title: 'T-20261125-03 DEPLOY', created_at: '2026-11-25T11:29:00Z' });
  const s = recordStart(empty(), 'a1', T('2026-11-25T16:00:00Z'));
  const review = post('REVIEW T-20261124-99: more notes', 'Muse', 'Today, Wed, Nov 25, 11:40am EST');
  assert.equal(decideRun({ now: NOON, openRows: [old, fresh], state: s, boardRows: [review] }).taskId, 'd9');
});

test('scheduling: DEPLOY lane first, then this repo, then other projects; a task past 2 runs a day yields but is not stopped', () => {
  const pf = task('pf1', { title: 'PeptideFacts preview', created_at: '2026-11-24T08:00:00Z' });
  const infra = task('in1', { title: 'T-20261125-05 poller tweak', details: 'REPO: mslugga35/muse-claude-pilot', created_at: '2026-11-25T09:00:00Z' });
  const dep = task('dp1', { title: 'T-20261125-03 DEPLOY: merge PR #10', created_at: '2026-11-25T11:29:00Z' });
  assert.equal(decideRun({ now: NOON, openRows: [pf, infra, dep], state: empty() }).taskId, 'dp1');
  assert.equal(decideRun({ now: NOON, openRows: [pf, infra], state: empty() }).taskId, 'in1');
  let s = recordStart(empty(), 'pf1', T('2026-11-25T13:00:00Z'));
  s = recordStart(s, 'pf1', T('2026-11-25T14:00:00Z'));
  const review = post('REVIEW pf1: more', 'Muse', 'Today, Wed, Nov 25, 11:30am EST');
  const other = task('zz9', { created_at: '2026-11-25T10:00:00Z' });
  assert.equal(decideRun({ now: NOON, openRows: [pf, other], state: s, boardRows: [review] }).taskId, 'zz9', 'busy task yields');
  assert.equal(decideRun({ now: NOON, openRows: [pf], state: s, boardRows: [review] }).taskId, 'pf1', 'alone, it keeps working');
});

test('low memory: the run is skipped (LOW_MEMORY), nothing else is touched', async () => {
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), freeMemoryMB: 900 }).reason, 'LOW_MEMORY');
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), freeMemoryMB: 4000 }).action, 'RUN');
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x'); const sp = fakeSpawn(0);
  const r = await checkOnce({ home: h, now: NOON, env, spawnImpl: sp.impl, readTasks: async () => [task('a1')], freeMemImpl: () => 800 * 1048576 });
  assert.equal(r.outcome, 'LOW_MEMORY'); assert.equal(sp.calls.length, 0);
});

test('after a run, the worker cleans up only the descendant processes of that run', async () => {
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x'); const sp = fakeSpawn(0);
  const calls = [];
  const impl = (cmd, args, opts) => { const c = sp.impl(cmd, args, opts); c.pid = 4242; return c; };
  await checkOnce({ home: h, now: NOON, env, spawnImpl: impl, readTasks: async () => [task('a1')], freeMemImpl: () => 8e9,
    cleanupImpl: async (pid, at) => { calls.push([pid, typeof at]); return 2; } });
  assert.deepEqual(calls, [[4242, 'number']]);
  assert.match(fs.readFileSync(path.join(h, 'worker.log'), 'utf8'), /"CLEANUP".*"stopped":2/);
});

test('daily usage summary: runs, minutes, list-price total, per task, outcomes (no LLM)', async () => {
  const { usageSummary } = await import('../lib.js');
  const st = { runs: [
    { taskId: 'a1', startedAt: '2026-11-25T13:00:00Z', seconds: 600, costUsd: 1.5, turns: 20, denials: 1, outcome: 'EXITED_OK' },
    { taskId: 'a1', startedAt: '2026-11-25T15:00:00Z', seconds: 120, costUsd: 0.5, turns: 5, denials: 0, outcome: 'EXITED_OK' },
    { taskId: 'b2', startedAt: '2026-11-26T03:00:00Z', seconds: 60, costUsd: 0.25, turns: 3, outcome: 'KILLED_TIMEOUT' }, // 22:00 ET Nov 25
    { taskId: 'c3', startedAt: '2026-11-26T06:00:00Z', seconds: 60, costUsd: 9, turns: 3, outcome: 'EXITED_OK' } ] }; // Nov 26 ET
  const u = usageSummary(st, '2026-11-25');
  assert.deepEqual([u.runs, u.minutes, u.listPriceUsd, u.turns, u.permissionDenials], [3, 13, 2.25, 28, 1]);
  assert.deepEqual(u.byTask, { a1: 2, b2: 1 });
  assert.deepEqual(u.outcomes, { EXITED_OK: 2, KILLED_TIMEOUT: 1 });
});

// ---- Subscription usage (T-20261125-05) ----
// A real rate_limit_event line as Claude Code 2026-11 prints it in stream-json mode (ids removed).
const EV = (info) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
const OK_EVENT = EV({ status: 'allowed_warning', resetsAt: 1795626000, rateLimitType: 'seven_day', utilization: 0.78, overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled', isUsingOverage: false, surpassedThreshold: 0.75,
  unifiedWindows: { seven_day: { utilization: 0.78, resetsAt: 1795626000, status: 'allowed_warning', surpassedThreshold: 0.75 } }, overageEnabled: false });
const REFUSED = EV({ status: 'rejected', resetsAt: 1795640400, rateLimitType: 'five_hour', utilization: 1, isUsingOverage: false, overageEnabled: false,
  unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1795640400, status: 'rejected' } } }); // resets 21:00Z

test('usage reading: parsed from the stream, newest event wins, junk ignored', () => {
  const r = readingFromStream(`{"type":"system"}\nnot json\n${OK_EVENT}\n{"type":"result"}`, NOON);
  assert.equal(r.windows.seven_day.utilization, 0.78);
  assert.equal(r.windows.seven_day.resetsAt, 1795626000 * 1000);
  assert.deepEqual([r.overageEnabled, r.isUsingOverage, r.observedAt], [false, false, NOON.toISOString()]);
  assert.equal(readingFromStream(`${OK_EVENT}\n${REFUSED}`).status, 'rejected');
  assert.equal(readingFromStream('{"type":"result"}'), null);
});

test('usage gate: work at any utilization; pause on refusal until the reset, then resume by itself', () => {
  const ok = readingFromStream(OK_EVENT, NOON);
  assert.equal(usageGate(ok, NOON), null, '78% weekly: keep working (owner: if I hit the limit I hit it)');
  assert.equal(usageGate(null, NOON), null, 'no reading yet: work');
  const refused = readingFromStream(REFUSED, NOON);
  const g = usageGate(refused, T('2026-11-25T18:00:00Z'));
  assert.deepEqual([g.reason, g.until], ['LIMIT_PAUSE', '2026-11-25T21:00:00.000Z']);
  assert.equal(usageGate(refused, T('2026-11-25T21:00:01Z')), null, 'after the reset: resume');
  const st = { ...empty(), limits: refused };
  assert.equal(decideRun({ now: T('2026-11-25T18:00:00Z'), openRows: [task('a1')], state: st }).reason, 'LIMIT_PAUSE');
  assert.equal(decideRun({ now: T('2026-11-25T21:05:00Z'), openRows: [task('a1')], state: st }).action, 'RUN');
});

test('usage gate: never runs while paid extra usage is on or in use (owner approval required)', () => {
  const on = readingFromStream(EV({ status: 'allowed', resetsAt: 1795626000, overageEnabled: true, isUsingOverage: false }), NOON);
  const using = readingFromStream(EV({ status: 'allowed', resetsAt: 1795626000, overageEnabled: false, isUsingOverage: true }), NOON);
  assert.equal(usageGate(on, NOON).reason, 'OVERAGE_GUARD');
  assert.equal(usageGate(using, NOON).reason, 'OVERAGE_GUARD');
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: { ...empty(), limits: on } }).reason, 'OVERAGE_GUARD');
});

test('inactivity: consecutive same-reason checks merge into one period; daily minutes per reason', () => {
  let s = empty();
  for (let i = 0; i < 6; i += 1) s = recordSkip(s, 'ALL_WAITING_ON_OTHERS', new Date(+NOON + i * 10 * 60000));
  s = recordSkip(s, 'LIMIT_PAUSE', new Date(+NOON + 60 * 60000));
  s = recordSkip(s, 'ALL_WAITING_ON_OTHERS', new Date(+NOON + 70 * 60000));
  assert.equal(s.periods.length, 3);
  const sum = inactivitySummary(s, '2026-11-25');
  assert.deepEqual(sum.minutesByReason, { ALL_WAITING_ON_OTHERS: 70, LIMIT_PAUSE: 10 });
  assert.deepEqual(sum.periods.map((p) => [p.reason, p.minutes]), [['ALL_WAITING_ON_OTHERS', 60]]);
});

test('checkOnce: streams output, stores the live usage reading, next check pauses on a refusal; skips are logged as periods', async () => {
  const h = home(); fs.writeFileSync(path.join(h, 'worker-prompt.md'), 'x');
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push(args);
    fs.writeSync(opts.stdio[1], `${OK_EVENT}\n${REFUSED}\n{"type":"result","num_turns":4,"total_cost_usd":0.5,"permission_denials":[]}\n`);
    const c = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('exit', 0, null)); return c;
  };
  const now = T('2026-11-25T18:00:00Z');
  await checkOnce({ home: h, now, env, spawnImpl: impl, readTasks: async () => [task('a1'), task('b2')] });
  const a = calls[0];
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json'); assert.ok(a.includes('--verbose'));
  const st = JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8'));
  assert.equal(st.limits.status, 'rejected');
  assert.deepEqual([st.runs[0].turns, st.runs[0].costUsd], [4, 0.5]);
  const r2 = await checkOnce({ home: h, now: new Date(+now + 15 * 60000), env, spawnImpl: impl, readTasks: async () => [task('b2')] });
  assert.deepEqual([r2.outcome, r2.until], ['LIMIT_PAUSE', '2026-11-25T21:00:00.000Z']);
  assert.equal(calls.length, 1, 'no run while refused');
  const st2 = JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8'));
  assert.equal(st2.periods.at(-1).reason, 'LIMIT_PAUSE');
  const u = JSON.parse(fs.readFileSync(path.join(h, 'usage-summary.json'), 'utf8'));
  assert.ok(u.today.latestUsageReading && u.today.inactivity);
});
