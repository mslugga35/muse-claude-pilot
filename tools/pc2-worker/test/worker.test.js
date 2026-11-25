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
const task = (id, extra = {}) => ({ id, status: 'open', for: 'Pilot Harness (Claude Code PC2)', title: `t ${id}`,
  created_at: '2026-11-24T10:00:00Z', ...extra });
const empty = () => ({ runs: [], attempts: {} });

test('only open tasks for the harness count, oldest first; ids validated', () => {
  const rows = [task('b2', { created_at: '2026-11-25T01:00:00Z' }), task('a1'), task('c3', { for: 'Muse' }),
    task('d4', { status: 'done' }), task('bad id!'), task('e5', { for: 'claude', created_at: '2026-11-24T11:00:00Z' })];
  assert.deepEqual(harnessTasks(rows).map((t) => t.id), ['a1', 'e5', 'b2']);
});

test('skips: paused, outside 08:05-22:05 ET, run in progress, nothing open', () => {
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), paused: true }).reason, 'PAUSED');
  assert.equal(decideRun({ now: T('2026-11-25T12:00:00Z'), openRows: [task('a1')], state: empty() }).reason, 'OUT_OF_WINDOW');
  assert.equal(decideRun({ now: T('2026-11-26T03:10:00Z'), openRows: [task('a1')], state: empty() }).reason, 'OUT_OF_WINDOW');
  assert.equal(decideRun({ now: NOON, openRows: [task('a1')], state: empty(), running: true }).reason, 'RUN_IN_PROGRESS');
  assert.equal(decideRun({ now: NOON, openRows: [task('c3', { for: 'Muse' })], state: empty() }).reason, 'NO_HARNESS_TASKS');
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
