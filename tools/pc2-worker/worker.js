// PC2 worker: one check. Task Scheduler runs it every 10 minutes (run-worker.ps1 supplies the read-only Crosswalk key).
// 1. Reads the open task board (read-only key, peek: nothing marked read).
// 2. decideRun() picks at most ONE open task for the harness, under the caps in lib.js.
// 3. Starts ONE headless Claude Code run for it and waits (killed after runTimeoutMinutes).
// It never posts, merges or deploys itself; the headless run does the work under the user's own permission rules
// (permission mode "auto": nothing is bypassed, anything that would need a prompt is denied).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Crosswalk, acquireLock } from '../wake-poller/poller.js';
import { DEFAULTS as POLLER } from '../wake-poller/lib.js';
import { WORKER_DEFAULTS, decideRun, recordStart, runPrompt } from './lib.js';

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

export async function readOpenTasks({ key, fetchImpl = fetch }) {
  const cw = new Crosswalk({ url: POLLER.crosswalkUrl, key, agent: POLLER.pollerAgent, fetchImpl });
  await cw.connect();
  const out = JSON.parse(await cw.call('read', { action: 'all', crosswalk: `${POLLER.crosswalk}/tasks`, peek: true, scope: 'agent', budget_tokens: 12000 }));
  const open = out.open || [];
  // Posts are read only when a harness task is open, so an empty queue costs one small read and no LLM call.
  const rows = open.length ? await cw.boardRows(POLLER.crosswalk, 3) : [];
  return { open, rows };
}

export async function checkOnce({ home = workerHome(), now = new Date(), env = process.env, fetchImpl = fetch, spawnImpl = spawn, readTasks = readOpenTasks, dryRun = false } = {}) {
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
    }
    const state = loadState(home);
    const d = decideRun({ now, openRows, state, running, paused, boardRows, cfg });
    if (d.action !== 'RUN') { log(home, 'CHECK', { outcome: d.reason, open: d.open, waiting: d.waiting }); return { outcome: d.reason }; }
    if (dryRun) { log(home, 'CHECK', { outcome: 'DRY_RUN_WOULD_RUN', taskId: d.taskId }); return { outcome: 'DRY_RUN_WOULD_RUN', taskId: d.taskId }; }
    saveState(home, recordStart(state, d.taskId, now)); // recorded BEFORE starting: a crash never causes a rapid re-run
    log(home, 'RUN_START', { taskId: d.taskId, title: d.title });
    const res = await runClaude({ home, cfg, taskId: d.taskId, spawnImpl });
    const s2 = loadState(home);
    const last = s2.runs[s2.runs.length - 1];
    if (last && last.taskId === d.taskId) Object.assign(last, { endedAt: new Date().toISOString(), outcome: res.outcome, exitCode: res.code });
    saveState(home, s2);
    log(home, 'RUN_END', { taskId: d.taskId, outcome: res.outcome, exitCode: res.code, seconds: res.seconds });
    return { outcome: res.outcome, taskId: d.taskId };
  } finally {
    if (lock) lock(); // acquireLock returns its release function
  }
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
    '--max-budget-usd', String(cfg.maxBudgetUsd), '--output-format', 'json'];
  const started = Date.now();
  const out = fs.openSync(path.join(home, 'runs', `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${taskId}.json`), 'w');
  return new Promise((resolve) => {
    // shell: false and the real executable, so the prompt argument can never be re-parsed by a shell.
    // The read-only board key is for the pre-check only: never inherited by the headless run.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/CROSSWALK_POLLER_KEY|ROUTINE_FIRE_TOKEN/i.test(k)) delete env[k];
    const child = spawnImpl(claudeExe(cfg), args, { cwd: cfg.workDir || process.env.USERPROFILE, env, stdio: ['ignore', out, out], windowsHide: true, shell: false });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, cfg.runTimeoutMinutes * 60 * 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); fs.closeSync(out);
      resolve({ outcome: signal ? 'KILLED_TIMEOUT' : code === 0 ? 'EXITED_OK' : 'EXITED_ERROR', code, seconds: Math.round((Date.now() - started) / 1000) });
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
