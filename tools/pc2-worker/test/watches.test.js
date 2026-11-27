import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeWatches, watchHits, watchWindowDays } from '../lib.js';
import { checkWatches, checkOnce } from '../worker.js';
import { DEFAULTS as POLLER } from '../../wake-poller/lib.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const MUSE = POLLER.taskPosterNumbers[0];
const W = { id: 'pf-007', match: ['PF-20261125-007', 'V9 verification'], since: '2026-11-26T10:00:00Z', expires: '2026-11-27T00:00:00Z' };
// when: the board's own format, as parseWhen reads it (11:00Z = 6:00am EST).
const row = (id, brief, when = 'Thu, Nov 26, 6:00am EST', via_number = MUSE) => ({ id, brief, via_number, via: 'lilSlug (Muse)', when });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));

test('activeWatches: expired, future/missing since, malformed, short or oversized terms are ignored', () => {
  const list = [W, { ...W, id: 'old', expires: '2026-11-25T00:00:00Z' }, { ...W, id: 'bad id!' }, { ...W, id: 'nomatch', match: [] },
    { ...W, id: 'long', match: ['x'.repeat(81)] }, { ...W, id: 'short', match: ['PF'] }, { ...W, id: 'str', match: 'PF-20261125-007' },
    { ...W, id: 'nosince', since: undefined }, { ...W, id: 'future', since: '2026-11-27T00:00:00Z' }, null];
  assert.deepEqual(activeWatches(list, NOW).map((w) => w.id), ['pf-007']);
  assert.deepEqual(activeWatches('nope', NOW), []);
});

test('watchHits: only Muse by Crosswalk number, any term, case-insensitive, each post once', () => {
  const rows = [row('a1', 'PF V9 VERIFICATION PASS on e0cd2df'), row('b2', 'unrelated'), row('c3', 'PF-20261125-007 PASS', undefined, '9999-copycat'),
    row('bad!', 'PF-20261125-007'), row('d4', 'pf-20261125-007 FAIL')];
  assert.deepEqual(watchHits([W], rows, {}, undefined, NOW).map((h) => h.postId), ['a1', 'd4']);
  assert.deepEqual(watchHits([W], rows, { 'pf-007:a1': 'x' }, undefined, NOW).map((h) => h.postId), ['d4']);
  assert.equal(watchHits([W], [row('e5', 'V9 verification ' + 'x'.repeat(500))], {}, undefined, NOW)[0].brief.length, 300);
});

test('watchHits: a matching post from before the watch was set (e.g. the assignment) never counts; unparseable time is skipped', () => {
  const rows = [row('old1', 'PF-20261125-007 QA_REQUEST', 'Wed, Nov 25, 3:00pm EST'), row('nt', 'PF-20261125-007 PASS', 'sometime'),
    row('new1', 'PF-20261125-007 PASS', 'Thu, Nov 26, 6:30am EST')];
  assert.deepEqual(watchHits([W], rows, {}, undefined, NOW).map((h) => h.postId), ['new1']);
});

test('watchHits: the same post listed twice in one read is one hit', () => {
  const r = row('a1', 'PF-20261125-007 PASS');
  assert.equal(watchHits([W], [r, r], {}, undefined, NOW).length, 1);
});

test('watchWindowDays: back to the oldest since, 1 to 3 days', () => {
  assert.equal(watchWindowDays([W], NOW), 1);
  assert.equal(watchWindowDays([{ ...W, since: '2026-11-24T13:00:00Z' }], NOW), 2);
  assert.equal(watchWindowDays([{ ...W, since: '2026-10-01T00:00:00Z' }], NOW), 3);
});

test('checkWatches: no watches file = no board read; hits recorded once across restarts', async () => {
  const home = tmp();
  let reads = 0;
  const readRows = async () => { reads += 1; return [row('a1', 'PF-20261125-007 PASS')]; };
  assert.deepEqual(await checkWatches({ home, now: NOW, readRows }), { hits: 0 });
  assert.equal(reads, 0);
  fs.writeFileSync(path.join(home, 'watches.json'), JSON.stringify([W]));
  assert.deepEqual(await checkWatches({ home, now: NOW, readRows }), { hits: 1 });
  assert.deepEqual(await checkWatches({ home, now: NOW, readRows }), { hits: 0 }); // seen survives in state.json
  const lines = fs.readFileSync(path.join(home, 'watch-hits.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).postId, 'a1');
  assert.equal(reads, 2);
});

test('checkWatches: reuses rows the task check already read when the window fits', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'watches.json'), JSON.stringify([W]));
  const readRows = async () => { throw new Error('should not read'); };
  assert.deepEqual(await checkWatches({ home, now: NOW, rows: [row('z9', 'V9 verification FAIL')], readRows }), { hits: 1 });
});

test('checkWatches: dry run records nothing', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'watches.json'), JSON.stringify([W]));
  const r = await checkWatches({ home, now: NOW, readRows: async () => [row('a1', 'PF-20261125-007 PASS')], dryRun: true });
  assert.deepEqual(r, { hits: 1, dryRun: true });
  assert.equal(fs.existsSync(path.join(home, 'watch-hits.jsonl')), false);
  assert.equal(fs.existsSync(path.join(home, 'state.json')), false);
});

test('checkOnce: a failing watch read is logged and never blocks the task check', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'watches.json'), JSON.stringify([W]));
  const r = await checkOnce({ home, now: NOW, env: { CROSSWALK_POLLER_KEY: 'k' }, readTasks: async () => [],
    readWatchRows: async () => { throw new Error('boom'); }, dryRun: true });
  assert.ok(r.outcome);
  assert.match(fs.readFileSync(path.join(home, 'worker.log'), 'utf8'), /"event":"WATCH","outcome":"READ_FAILED"/);
});

test('watchHits: posts with an unreadable time are counted, not silently dropped; same-minute post after since counts', () => {
  const stats = {};
  const rows = [row('nt', 'PF-20261125-007 PASS', 'yesterday-ish'), row('m1', 'PF-20261125-007 PASS', 'Thu, Nov 26, 5:00am EST')];
  const w = { ...W, since: '2026-11-26T10:00:42Z' }; // 5:00:42am EST; the post shows 5:00am
  assert.deepEqual(watchHits([w], rows, {}, undefined, NOW, stats).map((h) => h.postId), ['m1']);
  assert.equal(stats.unparseable, 1);
  assert.deepEqual(stats.unparseableSamples, [{ postId: 'nt', when: 'yesterday-ish' }]);
});

test('checkWatches: logs UNPARSEABLE_TIME so a board format change is visible', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'watches.json'), JSON.stringify([W]));
  await checkWatches({ home, now: NOW, readRows: async () => [row('nt', 'PF-20261125-007 PASS', '2026-11-26 11:00 UTC')] });
  assert.match(fs.readFileSync(path.join(home, 'worker.log'), 'utf8'), /"outcome":"UNPARSEABLE_TIME","n":1/);
});

test('watchHits: a post dated "Today, ..." (how the board shows recent posts) counts', () => {
  const stats = {};
  const rows = [row('td', 'PF-20261125-007 VERDICT: FAIL', 'Today, Thu, Nov 26, 9:30am EST')];
  assert.deepEqual(watchHits([W], rows, {}, undefined, NOW, stats).map((h) => h.postId), ['td']);
  assert.equal(stats.unparseable, 0);
});
