const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_LOG_BYTES,
  TRIM_KEEP_LINES,
  formatLine,
  logEvent,
  readRecentLines,
} = require('../bin/lib/log.cjs');

const LINE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(auto|manual)\] /;

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-switch-log-test-'));
  return path.join(dir, 'nested', 'switch.log');
}

test('formatLine produces a local timestamp and source tag', () => {
  const date = new Date(2026, 5, 10, 9, 5, 3); // 2026-06-10 09:05:03 local
  assert.equal(
    formatLine('manual', 'Switched Claude to work', date),
    '2026-06-10 09:05:03 [manual] Switched Claude to work'
  );
  assert.match(formatLine('auto', 'Switched Codex to personal.'), LINE_PATTERN);
});

test('logEvent appends to the given path, creates dirs, and returns the line', () => {
  const logPath = tmpLogPath();
  const first = logEvent('auto', 'Switched Claude to a@example.com (rate limited).', logPath);
  const second = logEvent('manual', 'Switched Codex to personal', logPath);

  assert.match(first, /\[auto\] Switched Claude to a@example\.com \(rate limited\)\.$/);
  assert.match(second, /\[manual\] Switched Codex to personal$/);

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [first, second]);
  assert.deepEqual(readRecentLines(50, logPath), [first, second]);
  assert.deepEqual(readRecentLines(1, logPath), [second]);
});

test('logEvent trims an oversized file to the last lines and keeps appending', () => {
  const logPath = tmpLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const filler = Array.from(
    { length: 2000 },
    (_, i) => `2026-01-01 00:00:00 [auto] padding line ${i} ${'x'.repeat(600)}`
  );
  fs.writeFileSync(logPath, `${filler.join('\n')}\n`, 'utf8');
  assert.ok(fs.statSync(logPath).size > MAX_LOG_BYTES, 'fixture must exceed the trim threshold');

  const line = logEvent('manual', 'Switched Claude to b@example.com', logPath);

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, TRIM_KEEP_LINES + 1);
  assert.equal(lines[lines.length - 1], line);
  assert.equal(lines[0], filler[filler.length - TRIM_KEEP_LINES]);
});

test('readRecentLines returns null when no history exists', () => {
  const logPath = tmpLogPath();
  assert.equal(readRecentLines(50, logPath), null);
});
