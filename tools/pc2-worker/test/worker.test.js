import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WORKER_DEFAULTS as D, harnessTasks, decideRun, recordStart, runsToday, runPrompt } from '../lib.js';
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
  assert.equal(decideRun({ now: new Date(+NOON + 10 * 60000), openRows: rows, state: s }).reason, 'MIN_GAP');
  const d2 = decideRun({ now: new Date(+NOON + 25 * 60000), openRows: rows, state: s });
  assert.equal(d2.taskId, 'b2'); // a1 attempted < 6 h ago
  s = recordStart(s, 'b2', new Date(+NOON + 25 * 60000));
  assert.equal(decideRun({ now: new Date(+NOON + 60 * 60000), openRows: rows, state: s }).reason, 'ALL_ATTEMPTED_RECENTLY');
  assert.equal(decideRun({ now: new Date(+NOON + 7 * 3600000), openRows: rows, state: s }).taskId, 'a1'); // retry after 6 h
  s.attempts.a1 = { count: D.maxAttemptsPerTask, lastAt: '2026-11-20T00:00:00Z' };
  s.attempts.b2 = { count: D.maxAttemptsPerTask, lastAt: '2026-11-20T00:00:00Z' };
  assert.equal(decideRun({ now: new Date(+NOON + 8 * 3600000), openRows: rows, state: s }).reason, 'ALL_ATTEMPTED_RECENTLY');
});

test('daily cap counts Eastern-date runs only', () => {
  let s = empty();
  for (let i = 0; i < D.maxRunsPerDay; i += 1) s = recordStart(s, `x${i}`, new Date(+T('2026-11-25T13:10:00Z') + i * 30 * 60000));
  assert.equal(runsToday(s, NOON), D.maxRunsPerDay);
  assert.equal(decideRun({ now: T('2026-11-25T23:00:00Z'), openRows: [task('a1')], state: s }).reason, 'DAILY_CAP');
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
  assert.equal(decideRun({ now: new Date(+NOON + 30 * 60000), openRows: [t], state: s, boardRows: [review] }).reason, 'ALL_ATTEMPTED_RECENTLY');
});

test('an explicit RELEASED post ends a hold by another session', () => {
  const t = task('jvhe06', { title: 'T-20261125-02: failover' });
  const rows = [post('[HARNESS] RELEASED T-20261125-02 to the PC2 worker', 'Pilot Harness (Claude Code PC2)'),
    post('[HARNESS] IN PROGRESS (interactive session) T-20261125-02', 'Pilot Harness (Claude Code PC2)')];
  assert.equal(boardSkip(t, rows, NOON), null);
});
