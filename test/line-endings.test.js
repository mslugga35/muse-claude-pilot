// Repo text files must use LF. CRLF crept in twice on 2026-11-24/25 from Windows text-mode writes (lesson L-001).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

test('tracked text files have no CRLF line endings', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(js|mjs|json|md|ps1|yml|yaml|txt)$/.test(f));
  const bad = files.filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n'));
  assert.deepEqual(bad, [], `CRLF found in: ${bad.join(', ')}`);
});

test('source files contain no stray control characters (lesson L-002: a Python "\b" became a backspace in a regex)', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => /\.(js|mjs|ps1)$/.test(f));
  // eslint-disable-next-line no-control-regex
  const bad = files.filter((f) => fs.existsSync(f) && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad, [], `control characters in: ${bad.join(', ')}`);
});
