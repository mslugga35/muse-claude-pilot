// End-to-end polls against fake Crosswalk + fake routine API (no network, no real credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, acquireLock, loadState } from '../poller.js';

const MUSE = '1111-0507-5348-4228';
const CC = '1111-9707-8156-4735';
const FAKE_KEY = 'cwk_test_key_not_real_0001';
const FAKE_TOKEN = 'fake-routine-token-for-tests-0001';
const env = { CROSSWALK_POLLER_KEY: FAKE_KEY, ROUTINE_FIRE_TOKEN: FAKE_TOKEN };

const taskBody = (id, { rev = 0, repo = 'mslugga35/muse-claude-pilot', extra = '' } = {}) => [
  `--- post #${id} in museclaudepilot by you via Muse on Sun, Nov 22, 10:00am EST ---`, 'brief: x', '',
  'TYPE: TASK', `TASK_ID: T-20261122-01`, `REV: ${rev}`, 'FOR: CC Engineer', repo ? `REPO: ${repo}` : '', extra, '--- end post ---'].join('\n');

function fakeWorld({ fireStatus = 200, fireThrows = null } = {}) {
  const world = { rows: [], bodies: {}, fires: [], opens: 0, authSeen: new Set() };
  world.fetch = async (url, opts) => {
    const auth = opts.headers.authorization;
    world.authSeen.add(auth);
    const reply = (status, json, headers = {}) => ({ status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => JSON.stringify(json) });
    if (url.includes('/fire')) {
      world.fires.push(JSON.parse(opts.body));
      if (fireThrows) { const e = new Error('x'); e.name = fireThrows; throw e; }
      return reply(fireStatus, fireStatus === 200 ? { type: 'routine_fire', claude_code_session_id: `cse_test_${world.fires.length}` } : { error: { type: 'api_error' } }, { 'retry-after': '60' });
    }
    if (auth !== `Bearer ${FAKE_KEY}`) return reply(401, {});
    const msg = JSON.parse(opts.body);
    if (msg.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return reply(202, {});
    const { name, arguments: a } = msg.params;
    assert.equal(a.peek, true, 'poller must never mark posts as read');
    let text;
    if (name === 'read') text = JSON.stringify(world.truncated ? { feed: world.rows, next_cursor: 1 } : { feed: world.rows });
    else if (name === 'open') { world.opens += 1; assert.equal(a.ids.length, 1); text = world.bodies[a.ids[0]] || ''; }
    else throw new Error(`poller called a non-read tool: ${name}`);
    return reply(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  };
  world.post = (id, brief, when = 'Sun, Nov 22, 10:00am EST', via = MUSE) => world.rows.unshift({ id, brief, when, via_number: via, via: via === CC ? 'CC Engineer (Claude routine)' : 'Muse' });
  return world;
}

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wake-poller-'));
const T = (iso) => new Date(iso);

test('new in-window task wakes once; later polls never wake it again', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer: add x', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  const r1 = await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch });
  assert.equal(r1.outcome, 'WAKE_WOKEN'); assert.equal(r1.postToWakeSeconds, 120); assert.equal(w.fires.length, 1);
  assert.match(w.fires[0].text, /post id: p1/);
  const r2 = await runOnce({ home: h, now: T('2026-11-22T15:27:00Z'), env, fetchImpl: w.fetch });
  assert.notEqual(r2.outcome, 'WAKE_WOKEN'); assert.equal(w.fires.length, 1);
  assert.equal(w.opens, 1, 'task body opened once, then cached');
});

test('with a configured 08:05-22:05 window: no wake (and no board read) until the first poll at/after 08:05 ET', async () => {
  const h = home(); const w = fakeWorld();
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ windowStart: '08:05', windowEnd: '22:05', hourlyCron: '5 0-3,13-23 * * *' }));
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 2:00am EST'); w.bodies.p1 = taskBody('p1');
  for (const iso of ['2026-11-22T07:00:00Z', '2026-11-22T12:59:00Z', '2026-11-22T13:04:00Z']) {
    assert.equal((await runOnce({ home: h, now: T(iso), env, fetchImpl: w.fetch })).outcome, 'OUT_OF_WINDOW');
  }
  assert.equal(w.authSeen.size, 0, 'nothing contacted outside the window');
  // 08:05 = the hourly run's own fire time -> defer; 08:10 still inside its boot window -> defer; 08:15 no ACK -> wake
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T13:05:00Z'), env, fetchImpl: w.fetch })).outcome, 'DEFER');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T13:10:00Z'), env, fetchImpl: w.fetch })).outcome, 'DEFER');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T13:15:00Z'), env, fetchImpl: w.fetch })).outcome, 'WAKE_WOKEN');
  assert.equal(w.fires.length, 1);
});

test('overnight task picked up by the 08:05 hourly run: deferred, then ACK seen, no duplicate wake', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 2:00am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T13:05:00Z'), env, fetchImpl: w.fetch })).outcome, 'DEFER');
  w.post('a1', '[CC] ACK T-20261122-01/rev0 — branch claude/x', 'Sun, Nov 22, 8:06am EST', CC);
  const r = await runOnce({ home: h, now: T('2026-11-22T13:15:00Z'), env, fetchImpl: w.fetch });
  assert.equal(r.outcome, 'NOTHING'); assert.equal(w.fires.length, 0);
});

test('unauthorized project tasks (PeptideFacts, MM Payments) are skipped and never fire', async () => {
  const h = home(); const w = fakeWorld();
  w.post('pf', 'TASK T-20261122-01 rev0 for CC Engineer: PeptideFacts recon'); w.bodies.pf = taskBody('pf', { extra: 'repo C:\\Users\\mslug\\pf-release' });
  w.post('mm', 'TASK T-20261122-01 rev1 for CC Engineer: MM site'); w.bodies.mm = taskBody('mm', { rev: 1, repo: 'mslugga35/mm-payments' });
  const r = await runOnce({ home: h, now: T('2026-11-22T15:30:00Z'), env, fetchImpl: w.fetch });
  assert.equal(r.outcome, 'NOTHING'); assert.equal(w.fires.length, 0);
  const st = loadState(h);
  assert.equal(st.classified.pf.verdict, 'SKIP_UNAUTHORIZED_PROJECT');
  assert.equal(st.classified.mm.verdict, 'SKIP_UNAUTHORIZED_REPO');
  const log = fs.readFileSync(path.join(h, 'poller.log'), 'utf8');
  assert.match(log, /TASK_SKIPPED.*SKIP_UNAUTHORIZED_PROJECT/);
});

test('same work key posted twice (new post id) wakes only once', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch });
  w.post('p1b', 'TASK T-20261122-01 rev0 for CC Engineer (repost)', 'Sun, Nov 22, 10:25am EST'); w.bodies.p1b = taskBody('p1b');
  await runOnce({ home: h, now: T('2026-11-22T15:27:00Z'), env, fetchImpl: w.fetch });
  assert.equal(w.fires.length, 1);
});

test('revision after RESULT gets its own wake', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch });
  w.post('a1', '[CC] ACK T-20261122-01/rev0', 'Sun, Nov 22, 10:23am EST', CC);
  w.post('r1', '[CC] RESULT T-20261122-01/rev0 — PASS', 'Sun, Nov 22, 10:30am EST', CC);
  w.post('p2', 'REVISION T-20261122-01 rev1 for CC Engineer', 'Sun, Nov 22, 10:40am EST'); w.bodies.p2 = taskBody('p2', { rev: 1 });
  const r = await runOnce({ home: h, now: T('2026-11-22T15:42:00Z'), env, fetchImpl: w.fetch });
  assert.equal(r.outcome, 'WAKE_WOKEN'); assert.equal(r.workKey, 'T-20261122-01/rev1'); assert.equal(w.fires.length, 2);
});

test('API failure 500: UNCERTAIN, never retried automatically', async () => {
  const h = home(); const w = fakeWorld({ fireStatus: 500 });
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch })).outcome, 'WAKE_UNCERTAIN');
  await runOnce({ home: h, now: T('2026-11-22T15:27:00Z'), env, fetchImpl: w.fetch });
  await runOnce({ home: h, now: T('2026-11-22T15:32:00Z'), env, fetchImpl: w.fetch });
  assert.equal(w.fires.length, 1);
});

test('API timeout: UNCERTAIN, never retried', async () => {
  const h = home(); const w = fakeWorld({ fireThrows: 'TimeoutError' });
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch })).outcome, 'WAKE_UNCERTAIN');
  await runOnce({ home: h, now: T('2026-11-22T15:40:00Z'), env, fetchImpl: w.fetch });
  assert.equal(w.fires.length, 1);
});

test('API 401: FAILED, not retried', async () => {
  const h = home(); const w = fakeWorld({ fireStatus: 401 });
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch })).outcome, 'WAKE_FAILED');
  await runOnce({ home: h, now: T('2026-11-22T15:40:00Z'), env, fetchImpl: w.fetch });
  assert.equal(w.fires.length, 1);
});

test('crash mid-send (state left SENDING) becomes UNCERTAIN and is not re-sent', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify({ tasks: { 'T-20261122-01/rev0': { wake: { status: 'SENDING', attemptedAt: '2026-11-22T15:22:00Z', attempts: 1 } } },
    classified: {}, wakes: [{ at: '2026-11-22T15:22:00Z', workKey: 'T-20261122-01/rev0', status: 'SENDING' }] }));
  await runOnce({ home: h, now: T('2026-11-22T15:27:00Z'), env, fetchImpl: w.fetch });
  assert.equal(w.fires.length, 0);
  assert.equal(loadState(h).tasks['T-20261122-01/rev0'].wake.status, 'UNCERTAIN');
});

test('overlapping polls: a live lock makes the second poll exit without acting; stale lock is taken over', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  const release = acquireLock(h, T('2026-11-22T15:20:00Z'));
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch })).outcome, 'LOCKED');
  assert.equal(w.fires.length, 0);
  // lock never released (crashed run); 11 minutes later it is stale
  const r = await runOnce({ home: h, now: T('2026-11-22T15:31:00Z'), env, fetchImpl: w.fetch });
  assert.equal(r.outcome, 'WAKE_WOKEN');
  release();
});

test('concurrent polls in the same instant: exactly one fires', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  const now = T('2026-11-22T15:22:00Z');
  const rs = await Promise.all([1, 2, 3].map(() => runOnce({ home: h, now, env, fetchImpl: w.fetch })));
  assert.equal(w.fires.length, 1, JSON.stringify(rs.map((r) => r.outcome)));
});

test('no credentials in env -> CONFIG_ERROR, nothing contacted', async () => {
  const h = home(); const w = fakeWorld();
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env: {}, fetchImpl: w.fetch })).outcome, 'CONFIG_ERROR');
  assert.equal(w.authSeen.size, 0);
});

test('secrets never reach the log or state files', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch });
  for (const f of fs.readdirSync(h)) {
    const txt = fs.readFileSync(path.join(h, f), 'utf8');
    assert.ok(!txt.includes(FAKE_KEY) && !txt.includes(FAKE_TOKEN), f);
  }
});

test('config.json holding a secret is refused', async () => {
  const h = home(); const w = fakeWorld();
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ routineToken: 'x' }));
  await assert.rejects(runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch }), /must not hold secrets/);
});

test('a configured end date stops the poller after that day', async () => {
  const h = home(); const w = fakeWorld();
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ pilotEnd: '2026-11-27' }));
  assert.equal((await runOnce({ home: h, now: T('2026-11-28T15:00:00Z'), env, fetchImpl: w.fetch })).outcome, 'PILOT_ENDED');
  assert.equal(w.authSeen.size, 0);
});

test('truncated board read fails closed: no wake', async () => {
  const h = home(); const w = fakeWorld(); w.truncated = true;
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch })).outcome, 'BOARD_READ_FAILED');
  assert.equal(w.fires.length, 0);
});

test('dry run never fires and never changes state (cannot pre-consume a deferral)', async () => {
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 10:20am EST'); w.bodies.p1 = taskBody('p1');
  assert.equal((await runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env: { CROSSWALK_POLLER_KEY: FAKE_KEY }, fetchImpl: w.fetch, dryRun: true })).outcome, 'WAKE_DRY_RUN');
  assert.equal(w.fires.length, 0);
  assert.equal(fs.existsSync(path.join(h, 'state.json')), false);
});

test('config.json cannot redirect credentials or change who counts as Muse', async () => {
  for (const k of ['crosswalkUrl', 'routineId', 'taskPosterNumbers', 'repo']) {
    const h = home(); const w = fakeWorld();
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ [k]: 'x' }));
    await assert.rejects(runOnce({ home: h, now: T('2026-11-22T15:22:00Z'), env, fetchImpl: w.fetch }), /may not override/);
    assert.equal(w.authSeen.size, 0);
  }
});

test('lock: a just-created lock with no owner file yet is treated as live', () => {
  const h = home();
  fs.mkdirSync(path.join(h, 'poller.lock'));
  assert.equal(acquireLock(h, new Date()), null);
});

test('lock: release never removes a lock that was taken over by another poll', () => {
  const h = home();
  const releaseOld = acquireLock(h, T('2026-11-22T15:00:00Z'));
  const releaseNew = acquireLock(h, T('2026-11-22T15:20:00Z'));
  assert.ok(releaseNew);
  releaseOld();
  assert.equal(acquireLock(h, T('2026-11-22T15:21:00Z')), null);
  releaseNew();
  assert.ok(acquireLock(h, T('2026-11-22T15:22:00Z')));
});

test('setup check: reads the board with the key, ignores the window, writes no state, never fires', async () => {
  const { checkCrosswalk } = await import('../poller.js');
  const h = home(); const w = fakeWorld();
  w.post('p1', 'TASK T-20261122-01 rev0 for CC Engineer', 'Sun, Nov 22, 2:00am EST');
  assert.deepEqual(await checkCrosswalk({ home: h, env, fetchImpl: w.fetch }), { outcome: 'CHECK_OK', rows: 1 });
  assert.equal((await checkCrosswalk({ home: h, env: { CROSSWALK_POLLER_KEY: 'wrong' }, fetchImpl: w.fetch })).outcome, 'CHECK_FAILED');
  assert.equal(w.fires.length, 0);
  assert.equal(fs.existsSync(path.join(h, 'state.json')), false);
});
