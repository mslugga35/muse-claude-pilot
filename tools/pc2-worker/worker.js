// PC2 worker: one check. Task Scheduler runs it every 10 minutes (run-worker.ps1 supplies the read-only Crosswalk key).
// 1. Reads the open task board (read-only key, peek: nothing marked read).
// 2. decideRun() picks at most ONE open task for the harness, under the caps in lib.js.
// 3. Starts ONE headless Claude Code run for it and waits (killed after runTimeoutMinutes).
// It never posts, merges or deploys itself; the headless run does the work under the user's own permission rules
// (permission mode "auto": nothing is bypassed, anything that would need a prompt is denied).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Crosswalk, acquireLock } from '../wake-poller/poller.js';
import { DEFAULTS as POLLER } from '../wake-poller/lib.js';
import { activeWatches, watchHits, watchWindowDays } from './lib.js';
import { WORKER_DEFAULTS, decideRun, recordStart, recordSkip, readingFromStream, runPrompt, usageSummary } from './lib.js';
import { wallClock } from '../wake-poller/lib.js';

export function workerHome() { return path.join(process.env.LOCALAPPDATA || '.', 'muse-ops-worker'); }

function log(home, event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'worker.log');
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
  fs.appendFileSync(file, `${line}\n`);
}
function loadState(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')); } catch { return { runs: [], attempts: {} }; }
}
function saveState(home, s) {
  const f = path.join(home, 'state.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2)); fs.renameSync(`${f}.tmp`, f);
}
function loadCfg(home) {
  let over = {};
  try { over = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* defaults */ }
  for (const k of Object.keys(over)) if (/key|token|secret|password|harnessNames|trusted/i.test(k)) throw new Error(`config.json may not set ${k}`);
  return { ...WORKER_DEFAULTS, ...over };
}

/** G2: remember tasks blocked by repeated failures (shown in usage-summary.json alerts, logged once as TASK_BLOCKED). New feedback or a success clears them. */
function trackBlocked(state, blocked, now, home) {
  const prev = state.blocked || {};
  const next = {};
  for (const [id, b] of Object.entries(blocked || {})) {
    next[id] = prev[id] || { since: now.toISOString(), failures: b.failures };
    if (!prev[id]) log(home, 'TASK_BLOCKED', { taskId: id, failures: b.failures, reason: 'consecutive failed runs; left for Muse/owner until new feedback' });
  }
  return { ...state, blocked: next };
}

export async function readOpenTasks({ key, fetchImpl = fetch }) {
  const cw = new Crosswalk({ url: POLLER.crosswalkUrl, key, agent: POLLER.pollerAgent, fetchImpl });
  await cw.connect();
  const out = JSON.parse(await cw.call('read', { action: 'all', crosswalk: `${POLLER.crosswalk}/tasks`, peek: true, scope: 'agent', budget_tokens: 12000 }));
  const open = out.open || [];
  // Posts are read only when a harness task is open, so an empty queue costs one small read and no LLM call.
  const rows = open.length ? await cw.boardRows(POLLER.crosswalk, 3) : [];
  return { open, rows };
}

/**
 * Board watches (see activeWatches in lib.js). Costs nothing without watches.json. With one: no LLM call, and when no
 * task read already fetched the posts, one extra read-only session (connect + up to 5 pages), back to the watch's
 * "since" (max 3 days). Paused or locked checks skip watches too, so a hit is only delayed, never lost while within
 * that window. Hits go to watch-hits.jsonl (append-only) and state.watchSeen, so a session
 * that stops and resumes never misses or repeats one. Never posts, never starts a run.
 */
export async function checkWatches({ home, now, key, fetchImpl = fetch, rows = null, readRows = null, dryRun = false }) {
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(home, 'watches.json'), 'utf8')); } catch { return { hits: 0 }; }
  const watches = activeWatches(list, now);
  if (!watches.length) return { hits: 0 };
  const days = watchWindowDays(watches, now);
  // Reuse the task read's posts only when they reach back far enough (that read covers 3 days).
  let board = rows && rows.length && days <= 3 ? rows : null;
  if (!board) {
    board = readRows ? await readRows(days) : await (async () => {
      const cw = new Crosswalk({ url: POLLER.crosswalkUrl, key, agent: POLLER.pollerAgent, fetchImpl });
      await cw.connect();
      return cw.boardRows(POLLER.crosswalk, days);
    })();
  }
  const state = loadState(home);
  const seen = state.watchSeen || {};
  const stats = {};
  const hits = watchHits(watches, board, seen, POLLER.taskPosterNumbers, now, stats);
  if (stats.unparseable) log(home, 'WATCH', { outcome: 'UNPARSEABLE_TIME', n: stats.unparseable });
  if (!hits.length) return { hits: 0 };
  if (dryRun) { log(home, 'WATCH', { outcome: 'DRY_RUN_WOULD_RECORD', hits: hits.map((h) => h.postId) }); return { hits: hits.length, dryRun: true }; }
  const file = path.join(home, 'watch-hits.jsonl');
  // Hits are appended BEFORE seen is saved (at-least-once): a crash in between can repeat a line on the next check, but
  // never loses one. watch-hits.jsonl is append-only; consumers dedupe by postId and track which ones they handled.
  fs.appendFileSync(file, hits.map((h) => JSON.stringify({ ts: now.toISOString(), ...h })).join('\n') + '\n');
  saveState(home, { ...loadState(home), watchSeen: seen });
  log(home, 'WATCH_HIT', { hits: hits.map((h) => ({ watchId: h.watchId, postId: h.postId })) });
  return { hits: hits.length };
}

export async function checkOnce({ home = workerHome(), now = new Date(), env = process.env, fetchImpl = fetch, spawnImpl = spawn, readTasks = readOpenTasks, readWatchRows = null, freeMemImpl = os.freemem, cleanupImpl = cleanupDescendants, dryRun = false } = {}) {
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  const cfg = loadCfg(home);
  const paused = fs.existsSync(path.join(home, 'PAUSE'));
  // Lock held for the whole run (stale after the run timeout + 10 min), so two runs can never overlap.
  const lock = acquireLock(home, now, (cfg.runTimeoutMinutes + 10) * 60 * 1000);
  const running = !lock;
  let openRows = []; let boardRows = null;
  try {
    if (!paused && !running) {
      if (!env.CROSSWALK_POLLER_KEY) { log(home, 'CHECK', { outcome: 'CONFIG_ERROR', reason: 'key missing from environment' }); return { outcome: 'CONFIG_ERROR' }; }
      try { const r = await readTasks({ key: env.CROSSWALK_POLLER_KEY, fetchImpl }); if (Array.isArray(r)) openRows = r; else { openRows = r.open; boardRows = r.rows; } } catch (e) {
        log(home, 'CHECK', { outcome: 'BOARD_READ_FAILED', error: String(e.message).slice(0, 120) }); return { outcome: 'BOARD_READ_FAILED' };
      }
      // A watch failure is logged and never blocks task work.
      try { await checkWatches({ home, now, key: env.CROSSWALK_POLLER_KEY, fetchImpl, rows: boardRows, readRows: readWatchRows, dryRun }); } catch (e) {
        log(home, 'WATCH', { outcome: 'READ_FAILED', error: String(e.message).slice(0, 120) });
      }
    }
    const state = loadState(home);
    try { writeUsage(home, now, cfg); } catch { /* reporting must never block work */ }
    const d = decideRun({ now, openRows, state, running, paused, boardRows, freeMemoryMB: freeMemImpl() / 1048576, cfg });
    if (d.action !== 'RUN') {
      log(home, 'CHECK', { outcome: d.reason, open: d.open, waiting: d.waiting, freeMemoryMB: d.freeMemoryMB, until: d.until, blocked: d.blocked });
      if (!running) { try { saveState(home, trackBlocked(recordSkip(loadState(home), d.reason, now), d.blocked, now, home)); } catch { /* reporting only */ } }
      return { outcome: d.reason, until: d.until };
    }
    if (dryRun) { log(home, 'CHECK', { outcome: 'DRY_RUN_WOULD_RUN', taskId: d.taskId }); return { outcome: 'DRY_RUN_WOULD_RUN', taskId: d.taskId }; }
    saveState(home, recordStart(state, d.taskId, now)); // recorded BEFORE starting: a crash never causes a rapid re-run
    log(home, 'RUN_START', { taskId: d.taskId, title: d.title });
    const res = await runClaude({ home, cfg, taskId: d.taskId, spawnImpl });
    // Stop anything the run left behind (dev servers, previews) so it can't eat memory; only its own descendants.
    const cleaned = res.pid ? await cleanupImpl(res.pid, res.startedAt) : 0;
    if (cleaned) log(home, 'CLEANUP', { taskId: d.taskId, stopped: cleaned });
    const s2 = loadState(home);
    const last = s2.runs[s2.runs.length - 1];
    if (last && last.taskId === d.taskId) Object.assign(last, { endedAt: new Date().toISOString(), outcome: res.outcome, exitCode: res.code, seconds: res.seconds, ...runStats(res.outFile) });
    // The run's own output carries the subscription's live usage (weekly / 5-hour utilization, reset time, extra-usage
    // status). Keep the latest: the next check pauses on a refusal until the reset, and never runs with extra usage on.
    let reading = null; try { reading = readingFromStream(fs.readFileSync(res.outFile, 'utf8')); } catch { /* no output */ }
    if (reading) s2.limits = reading;
    saveState(home, s2);
    log(home, 'RUN_END', { taskId: d.taskId, outcome: res.outcome, exitCode: res.code, seconds: res.seconds, usage: reading ? { status: reading.status, windows: reading.windows, overage: reading.isUsingOverage } : null });
    return { outcome: res.outcome, taskId: d.taskId };
  } finally {
    if (lock) lock(); // acquireLock returns its release function
  }
}

/**
 * Windows: stop processes descended from the finished run (matched by parent-pid chain AND created after the run
 * started, so a reused pid can't match an unrelated program). Returns how many were stopped. Never touches anything
 * else. Other platforms: no-op.
 */
export function cleanupDescendants(rootPid, startedAtMs) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid)) return Promise.resolve(0);
  const script = `$ErrorActionPreference='SilentlyContinue'; $t=[DateTime]::FromFileTimeUtc(${Math.floor(startedAtMs * 10000 + 116444736000000000)});`
    + "$all=Get-CimInstance Win32_Process | Where-Object { $_.CreationDate.ToUniversalTime() -ge $t };"
    + `$set=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$set.Add(${rootPid}); $grew=$true;`
    + 'while ($grew) { $grew=$false; foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId) -and $set.Add([int]$p.ProcessId)) { $grew=$true } } }'
    + `$n=0; foreach ($id in $set) { if ($id -ne ${rootPid}) { Stop-Process -Id $id -Force; $n++ } }; $n`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false });
    let out = ''; ps.stdout.on('data', (b) => { out += b; });
    ps.on('exit', () => resolve(Number.parseInt(out.trim(), 10) || 0)); ps.on('error', () => resolve(0));
  });
}

/** Turns, list-price cost and refusals from a run's output: the stream's final "result" line (or a plain JSON file). */
export function runStats(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.includes('"type":"result"'));
    const d = JSON.parse(lines.length ? lines[lines.length - 1] : text);
    return { turns: d.num_turns || 0, costUsd: d.total_cost_usd || 0, denials: (d.permission_denials || []).length };
  } catch { return {}; }
}

/** Writes usage-summary.json (today and yesterday, Eastern) so the daily report has real numbers. No LLM. */
export function writeUsage(home, now = new Date(), cfg = WORKER_DEFAULTS) {
  const state = loadState(home);
  const today = wallClock(now, cfg.timeZone).date;
  const yesterday = wallClock(new Date(+now - 24 * 3600 * 1000), cfg.timeZone).date;
  const out = { generatedAt: now.toISOString(), today: usageSummary(state, today, cfg), yesterday: usageSummary(state, yesterday, cfg) };
  fs.writeFileSync(path.join(home, 'usage-summary.json'), JSON.stringify(out, null, 2));
  return out;
}

export function claudeExe(cfg) {
  if (cfg.claudePath) return cfg.claudePath;
  const exe = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return fs.existsSync(exe) ? exe : 'claude';
}

function runClaude({ home, cfg, taskId, spawnImpl }) {
  const promptFile = path.join(home, 'worker-prompt.md');
  if (!fs.existsSync(promptFile)) return Promise.resolve({ outcome: 'NO_PROMPT_FILE', code: null, seconds: 0 });
  const args = ['-p', runPrompt(taskId), '--append-system-prompt-file', promptFile, '--permission-mode', 'auto',
    '--max-budget-usd', String(cfg.maxBudgetUsd), '--output-format', 'stream-json', '--verbose'];
  const started = Date.now();
  const outFile = path.join(home, 'runs', `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${taskId}.jsonl`);
  const out = fs.openSync(outFile, 'w');
  return new Promise((resolve) => {
    // shell: false and the real executable, so the prompt argument can never be re-parsed by a shell.
    // The read-only board key is for the pre-check only: never inherited by the headless run.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/CROSSWALK_POLLER_KEY|ROUTINE_FIRE_TOKEN/i.test(k)) delete env[k];
    const child = spawnImpl(claudeExe(cfg), args, { cwd: cfg.workDir || process.env.USERPROFILE, env, stdio: ['ignore', out, out], windowsHide: true, shell: false });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, cfg.runTimeoutMinutes * 60 * 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); fs.closeSync(out);
      resolve({ outcome: signal ? 'KILLED_TIMEOUT' : code === 0 ? 'EXITED_OK' : 'EXITED_ERROR', code, seconds: Math.round((Date.now() - started) / 1000), pid: child.pid, startedAt: started, outFile });
    });
    child.on('error', () => { clearTimeout(timer); try { fs.closeSync(out); } catch { /* closed */ } resolve({ outcome: 'SPAWN_FAILED', code: null, seconds: 0 }); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const home = workerHome();
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  checkOnce({ home, dryRun: process.argv.includes('--dry-run') })
    .then((r) => { process.exitCode = 0; console.log(r.outcome); })
    .catch((e) => { log(home, 'CRASH', { error: String(e.message).slice(0, 160) }); process.exitCode = 1; });
}
