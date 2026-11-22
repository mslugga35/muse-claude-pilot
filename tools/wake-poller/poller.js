#!/usr/bin/env node
// Crosswalk wake poller: one poll per invocation (Windows Task Scheduler runs it every 5 minutes).
// Reads the museclaudepilot board with a read-only key and fires the pilot routine's API trigger for a new,
// un-ACKed, authorized task. It never posts, edits, merges, deploys or touches a repo.
// Secrets come only from the environment (set per run by run-poller.ps1 from DPAPI-protected files):
//   CROSSWALK_POLLER_KEY, ROUTINE_FIRE_TOKEN. They are never logged or written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS, inWakeWindow, pilotEnded, wallClock, engineerProgress, taskCandidates, openedBlock,
  classifyTask, decide, classifyFire, wakeText, redact, parseWhen, wakesInLastHour,
} from './lib.js';

export function defaultHome() {
  return process.env.WAKE_POLLER_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'muse-wake-poller');
}

// ---------- files ----------
export function loadConfig(home) {
  const file = path.join(home, 'config.json');
  const over = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const k of Object.keys(over)) {
    if (/key|token|secret|password/i.test(k)) throw new Error(`config.json must not hold secrets (${k})`);
    // Where credentials are sent, and who counts as Muse/engineer/repo, are pinned in code, never in a local file.
    if (PINNED.includes(k)) throw new Error(`config.json may not override ${k}`);
  }
  return { ...DEFAULTS, ...over };
}
const PINNED = ['crosswalkUrl', 'routineId', 'repo', 'crosswalk', 'taskPosterNumbers', 'engineerNumbers', 'engineerAliases', 'forbiddenMarkers', 'anthropicBeta', 'anthropicVersion'];

export function loadState(home) {
  const file = path.join(home, 'state.json');
  if (!fs.existsSync(file)) return { version: 1, tasks: {}, classified: {}, wakes: [] };
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: 1, tasks: {}, classified: {}, wakes: [], ...s };
}

export function saveState(home, state) {
  const file = path.join(home, 'state.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomic replace: a crash never leaves half a history
}

export function makeLogger(home, now = () => new Date()) {
  const file = path.join(home, 'poller.log');
  return (event, fields = {}) => {
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    const t = now();
    const line = { ts: t.toISOString(), et: `${wallClock(t).date} ${wallClock(t).hhmm}`, event, ...fields };
    fs.appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
  };
}

/**
 * Single-instance lock: a directory (mkdir is atomic) holding an owner file with a random token.
 * Age comes from the owner file's own timestamp, falling back to the directory's mtime, so a half-written owner file
 * is never mistaken for stale. A stale lock is taken over by atomic rename to a unique name (only one racer wins),
 * and release removes the lock only if it is still ours.
 */
export function acquireLock(home, now = new Date(), staleMs = 10 * 60 * 1000) {
  const dir = path.join(home, 'poller.lock');
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ token, at: now.toISOString() }));
      return () => {
        try {
          const o = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
          if (o.token === token) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* gone or taken over: not ours to remove */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let at = null;
      try { at = new Date(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).at); } catch { /* being written */ }
      if (!at || Number.isNaN(at.getTime())) { try { at = fs.statSync(dir).mtime; } catch { continue; } }
      if (now - at < staleMs) return null; // live (or just created): back off
      const grave = `${dir}.stale-${token}`;
      try { fs.renameSync(dir, grave); } catch { return null; } // another poll won the takeover
      // Raced with another taker that already re-created a fresh lock? Then we just moved ITS lock: put it back, back off.
      let graveAt = null;
      try { graveAt = new Date(JSON.parse(fs.readFileSync(path.join(grave, 'owner.json'), 'utf8')).at); } catch { /* old */ }
      if (graveAt && now - graveAt < staleMs) { try { fs.renameSync(grave, dir); } catch { /* ours now; still back off */ } return null; }
      fs.rmSync(grave, { recursive: true, force: true });
    }
  }
  return null;
}

// ---------- Crosswalk (MCP over Streamable HTTP, read-only calls) ----------
export class Crosswalk {
  constructor({ url, key, agent, fetchImpl = fetch }) { Object.assign(this, { url, key, agent, fetchImpl, sid: null, n: 0 }); }

  async rpc(method, params, notify = false) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.key}` };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.n, method, params };
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const sid = res.headers?.get?.('mcp-session-id'); if (sid) this.sid = sid;
    if (notify) return null;
    const text = await res.text();
    if (res.status !== 200) throw new Error(`crosswalk ${method} HTTP ${res.status}`);
    let json;
    try {
      const msgs = text.trim().startsWith('{') ? [JSON.parse(text)]
        : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).map((l) => JSON.parse(l));
      json = msgs.find((m) => m.id === body.id);
    } catch { throw new Error(`crosswalk ${method} unparseable response`); } // fixed text: never echo response content
    if (!json) throw new Error(`crosswalk ${method} no response for request`);
    if (json.error) throw new Error(`crosswalk ${method} error ${Number(json.error.code) || 'unknown'}`);
    return json.result;
  }

  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse-wake-poller', version: '1.0.0' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  async call(name, args) {
    if (!READ_ONLY_TOOLS.has(name) || args.peek !== true) throw new Error('poller may only make peek reads'); // read-only by construction
    const r = await this.rpc('tools/call', { name, arguments: { agent: this.agent, ...args } });
    const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r?.isError) throw new Error(`crosswalk ${name} tool error`);
    return text;
  }

  async boardRows(crosswalk, days) {
    const rows = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const args = { action: 'all', crosswalk, peek: true, scope: 'agent', filter: { days }, budget_tokens: 24000 };
      if (cursor !== undefined) args.cursor = cursor;
      const out = JSON.parse(await this.call('read', args));
      rows.push(...(out.feed || []));
      if (out.next_cursor === undefined || out.next_cursor === null) return rows;
      cursor = out.next_cursor;
    }
    // Fail closed: a partial board could hide an ACK and cause a duplicate wake.
    throw new Error('crosswalk board read truncated');
  }

  /** One id per call, so a post body can never impersonate another post's block. */
  async openPost(id) {
    if (!/^\w{2,20}$/.test(id)) return null;
    return openedBlock(await this.call('open', { ids: [id], peek: true }), id);
  }
}
const READ_ONLY_TOOLS = new Set(['read', 'open']);

// ---------- routine fire ----------
export async function fireRoutine({ cfg, token, text, fetchImpl = fetch }) {
  const url = `https://api.anthropic.com/v1/claude_code/routines/${cfg.routineId}/fire`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'anthropic-version': cfg.anthropicVersion, 'anthropic-beta': cfg.anthropicBeta, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(cfg.fireTimeoutMs),
    });
    let json = {};
    try { json = JSON.parse(await res.text()); } catch { /* non-JSON body */ }
    return { status: res.status, sessionId: json.claude_code_session_id || null, sessionUrl: json.claude_code_session_url || null,
      errorType: json.error?.type || null, retryAfter: res.headers?.get?.('retry-after') || null };
  } catch (e) {
    return { status: null, error: e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

// ---------- one poll ----------
export async function runOnce({ home = defaultHome(), now = new Date(), env = process.env, fetchImpl = fetch, dryRun = false } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const log = makeLogger(home, () => now);
  const release = acquireLock(home, now);
  if (!release) { log('POLL_SKIPPED_LOCKED'); return { outcome: 'LOCKED' }; }
  try {
    const cfg = loadConfig(home);
    if (pilotEnded(now, cfg)) { log('POLL', { outcome: 'PILOT_ENDED' }); return { outcome: 'PILOT_ENDED' }; }
    if (!inWakeWindow(now, cfg)) { log('POLL', { outcome: 'OUT_OF_WINDOW' }); return { outcome: 'OUT_OF_WINDOW' }; }
    const key = env.CROSSWALK_POLLER_KEY; const token = env.ROUTINE_FIRE_TOKEN;
    if (!key || (!token && !dryRun)) { log('POLL', { outcome: 'CONFIG_ERROR', reason: 'credential missing from environment' }); return { outcome: 'CONFIG_ERROR' }; }

    const state = loadState(home);
    const persist = () => { if (!dryRun) saveState(home, state); }; // a dry run never changes history
    // A run that died mid-send left SENDING: the request may have reached the API, so it becomes UNCERTAIN, never retried.
    for (const [k, t] of Object.entries(state.tasks)) {
      if (t.wake?.status === 'SENDING') { t.wake.status = 'UNCERTAIN'; log('WAKE_RECOVERED_UNCERTAIN', { workKey: k }); }
    }
    for (const w of state.wakes) if (w.status === 'SENDING') w.status = 'UNCERTAIN';

    const cw = new Crosswalk({ url: cfg.crosswalkUrl, key, agent: cfg.pollerAgent, fetchImpl });
    let rows;
    try { await cw.connect(); rows = await cw.boardRows(cfg.crosswalk, cfg.lookbackDays); } catch (e) {
      log('POLL', { outcome: 'BOARD_READ_FAILED', error: e.message }); persist(); return { outcome: 'BOARD_READ_FAILED' };
    }
    const progress = engineerProgress(rows, now, cfg);

    // Classify new candidate posts once (posts are immutable), caching the verdict by post id.
    const candidates = taskCandidates(rows, cfg);
    const toOpen = candidates.filter((r) => !state.classified[r.id]).map((r) => r.id).slice(0, 8);
    for (const id of toOpen) {
      let block = null;
      try { block = await cw.openPost(id); } catch (e) { log('OPEN_FAILED', { postId: id, error: e.message }); continue; }
      if (!block) { log('OPEN_FAILED', { postId: id, error: 'post block not found' }); continue; }
      {
        const row = candidates.find((r) => r.id === id);
        const c = classifyTask(row, block, cfg);
        state.classified[id] = { ...c, poster: row.via_number, postedAt: parseWhen(row.when, now)?.toISOString() || null, brief: row.brief, seenAt: now.toISOString() };
        log(c.verdict === 'ELIGIBLE' ? 'TASK_ELIGIBLE' : 'TASK_SKIPPED', { postId: id, workKey: c.workKey || null, verdict: c.verdict, reason: c.reason || null });
      }
    }

    const eligible = candidates
      .map((r) => ({ r, c: state.classified[r.id] }))
      .filter(({ c }) => c && c.verdict === 'ELIGIBLE')
      .map(({ r, c }) => ({ workKey: c.workKey, postId: r.id, poster: r.via_number, postedAt: c.postedAt, brief: r.brief }))
      .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
    // Same WORK KEY posted twice (another post id): only the first post is ever the wake target.
    const seen = new Set();
    const unique = eligible.filter((e) => (seen.has(e.workKey) ? (log('TASK_DUPLICATE_POST', { workKey: e.workKey, postId: e.postId }), false) : seen.add(e.workKey)));

    const d = decide({ now, eligible: unique, state, progress, cfg });
    const summary = { outcome: d.action, rows: rows.length, eligible: unique.length, wakesLastHour: wakesInLastHour(state, now), reason: d.reason, workKey: d.task?.workKey || null };

    if (d.action === 'DEFER') {
      state.tasks[d.task.workKey] = { ...(state.tasks[d.task.workKey] || {}), postId: d.task.postId, poster: d.task.poster, deferredAt: now.toISOString() };
      log('WAKE_DEFERRED', { workKey: d.task.workKey, postId: d.task.postId, reason: d.reason });
    }
    if (d.action === 'WAKE' && dryRun) { log('WAKE_DRY_RUN', { workKey: d.task.workKey, postId: d.task.postId }); summary.outcome = 'WAKE_DRY_RUN'; }
    if (d.action === 'WAKE' && !dryRun) {
      const t = d.task;
      const prev = state.tasks[t.workKey]?.wake;
      const attempts = (prev?.attempts || 0) + 1;
      const record = { status: 'SENDING', attemptedAt: now.toISOString(), attempts };
      state.tasks[t.workKey] = { ...(state.tasks[t.workKey] || {}), postId: t.postId, poster: t.poster, identity: `${t.workKey}|${t.postId}|${t.poster}`, wake: record };
      const wakeEntry = { at: now.toISOString(), workKey: t.workKey, status: 'SENDING' };
      state.wakes.push(wakeEntry);
      persist(); // persisted BEFORE the request: a crash can never lead to a second send
      log('WAKE_ATTEMPT', { workKey: t.workKey, postId: t.postId, attempt: attempts });
      const res = await fireRoutine({ cfg, token, text: wakeText(t, cfg), fetchImpl });
      const status = classifyFire(res);
      Object.assign(record, { status, httpStatus: res.status, errorType: res.errorType || res.error || null, sessionId: res.sessionId || null });
      if (status === 'RATE_LIMITED') record.retryAfter = new Date(now.getTime() + 1000 * (Number(res.retryAfter) || 300)).toISOString();
      wakeEntry.status = status;
      const latencyS = t.postedAt ? Math.round((now - new Date(t.postedAt)) / 1000) : null;
      log(status === 'WOKEN' ? 'WAKE_OK' : 'WAKE_NOT_OK', { workKey: t.workKey, postId: t.postId, status, httpStatus: res.status, errorType: record.errorType, sessionId: record.sessionId, postToWakeSeconds: latencyS });
      summary.outcome = `WAKE_${status}`; summary.postToWakeSeconds = latencyS; summary.sessionId = record.sessionId;
    }

    // Keep history small: drop classifications and wake log entries older than 14 days.
    const cutoff = now.getTime() - 14 * 24 * 3600 * 1000;
    for (const [id, c] of Object.entries(state.classified)) if (new Date(c.seenAt).getTime() < cutoff) delete state.classified[id];
    state.wakes = state.wakes.filter((w) => new Date(w.at).getTime() >= cutoff);
    state.lastPoll = { at: now.toISOString(), ...summary };
    persist();
    log('POLL', summary);
    return summary;
  } finally {
    release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dryRun = process.argv.includes('--dry-run');
  runOnce({ dryRun }).then((r) => { process.stdout.write(`${r.outcome}\n`); process.exitCode = r.outcome === 'CONFIG_ERROR' ? 2 : 0; })
    .catch((e) => { try { makeLogger(defaultHome())('POLL_CRASHED', { error: e.message }); } catch { /* ignore */ } process.stdout.write('CRASHED\n'); process.exitCode = 1; });
}
