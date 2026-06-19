const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareVersions,
  checkForUpdate,
  runSelfUpdate,
  maybePrintUpdateNotice,
} = require('../bin/lib/update.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

// Per-test cache file isolation so we never touch the real
// ~/.oauth-switch/update-check.json.
let cacheCounter = 0;
function freshCachePath() {
  cacheCounter += 1;
  return path.join(os.tmpdir(), `oauth-switch-update-test-${process.pid}-${cacheCounter}.json`);
}

function readCacheFile(cachePath) {
  return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
}

// --- semver compare -----------------------------------------------------------

test('compareVersions: numeric, not lexical (1.9.0 < 1.10.0)', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
});

test('compareVersions: equal versions', () => {
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0); // missing segments treated as 0
});

test('compareVersions: greater / lesser by patch and major', () => {
  assert.equal(compareVersions('1.3.1', '1.3.0'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('compareVersions: non-numeric / missing segments degrade to 0', () => {
  assert.equal(compareVersions('', '1.0.0'), -1);
  assert.equal(compareVersions(undefined, undefined), 0);
});

// --- checkForUpdate: cache freshness ------------------------------------------

test('checkForUpdate: fresh cache (<24h) skips the network and uses cached latest', async () => {
  const cachePath = freshCachePath();
  const now = 1_000_000_000_000;
  fs.writeFileSync(cachePath, JSON.stringify({ latest: '1.5.0', checkedAt: now - 1000 }));

  let fetchCalls = 0;
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now,
    fetchLatest: async () => { fetchCalls += 1; return '9.9.9'; },
  });

  assert.equal(fetchCalls, 0); // no network call
  assert.equal(result.latest, '1.5.0'); // cached value, not 9.9.9
  assert.equal(result.updateAvailable, true);
});

test('checkForUpdate: stale cache (>24h) fetches and rewrites the cache', async () => {
  const cachePath = freshCachePath();
  const now = 2_000_000_000_000;
  fs.writeFileSync(cachePath, JSON.stringify({ latest: '1.2.0', checkedAt: now - DAY_MS - 1000 }));

  let fetchCalls = 0;
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now,
    fetchLatest: async () => { fetchCalls += 1; return '1.4.0'; },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.latest, '1.4.0');
  assert.equal(result.updateAvailable, true);
  const written = readCacheFile(cachePath);
  assert.equal(written.latest, '1.4.0');
  assert.equal(written.checkedAt, now);
});

test('checkForUpdate: missing cache fetches, writes cache', async () => {
  const cachePath = freshCachePath();
  const now = 3_000_000_000_000;

  let fetchCalls = 0;
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now,
    fetchLatest: async () => { fetchCalls += 1; return '1.3.0'; },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.updateAvailable, false); // same version
  assert.equal(readCacheFile(cachePath).latest, '1.3.0');
});

// --- checkForUpdate: updateAvailable comparison -------------------------------

test('checkForUpdate: newer latest -> updateAvailable true', async () => {
  const cachePath = freshCachePath();
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now: 1,
    fetchLatest: async () => '1.4.0',
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, '1.4.0');
});

test('checkForUpdate: same latest -> updateAvailable false', async () => {
  const cachePath = freshCachePath();
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now: 1,
    fetchLatest: async () => '1.3.0',
  });
  assert.equal(result.updateAvailable, false);
});

test('checkForUpdate: older latest (downgrade) -> updateAvailable false', async () => {
  const cachePath = freshCachePath();
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now: 1,
    fetchLatest: async () => '1.2.0',
  });
  assert.equal(result.updateAvailable, false);
});

// --- checkForUpdate: fail silently --------------------------------------------

test('checkForUpdate: fetchLatest throws -> no throw, updateAvailable false', async () => {
  const cachePath = freshCachePath();
  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now: 1,
    fetchLatest: async () => { throw new Error('offline'); },
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, null);
});

test('checkForUpdate: fetchLatest timeout (reject) falls back to stale cache value', async () => {
  const cachePath = freshCachePath();
  const now = 4_000_000_000_000;
  fs.writeFileSync(cachePath, JSON.stringify({ latest: '1.6.0', checkedAt: now - DAY_MS - 1 }));

  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now,
    fetchLatest: async () => { throw new Error('timed out'); },
  });

  // Stale cache forced a fetch; the fetch failed, so we fall back to the cached
  // value rather than erroring or claiming no update.
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, '1.6.0');
});

test('checkForUpdate: corrupt cache + fetch failure -> updateAvailable false, no throw', async () => {
  const cachePath = freshCachePath();
  fs.writeFileSync(cachePath, 'not json at all');

  const result = await checkForUpdate({
    cachePath,
    currentVersion: '1.3.0',
    now: 1,
    fetchLatest: async () => { throw new Error('boom'); },
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, null);
});

// --- maybePrintUpdateNotice ---------------------------------------------------

test('maybePrintUpdateNotice: prints one line when newer version exists', async () => {
  const cachePath = freshCachePath();
  const lines = [];
  const printed = await maybePrintUpdateNotice({
    currentVersion: '1.3.0',
    cachePath,
    now: 1,
    fetchLatest: async () => '1.4.0',
    log: (l) => lines.push(l),
  });
  assert.equal(printed, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'Update available: 1.3.0 -> 1.4.0. Run: oas update');
});

test('maybePrintUpdateNotice: prints nothing when up to date', async () => {
  const cachePath = freshCachePath();
  const lines = [];
  const printed = await maybePrintUpdateNotice({
    currentVersion: '1.3.0',
    cachePath,
    now: 1,
    fetchLatest: async () => '1.3.0',
    log: (l) => lines.push(l),
  });
  assert.equal(printed, false);
  assert.equal(lines.length, 0);
});

test('maybePrintUpdateNotice: OAUTH_SWITCH_NO_UPDATE_CHECK=1 skips entirely (no fetch)', async () => {
  const cachePath = freshCachePath();
  const prev = process.env.OAUTH_SWITCH_NO_UPDATE_CHECK;
  process.env.OAUTH_SWITCH_NO_UPDATE_CHECK = '1';
  let fetchCalls = 0;
  const lines = [];
  try {
    const printed = await maybePrintUpdateNotice({
      currentVersion: '1.3.0',
      cachePath,
      now: 1,
      fetchLatest: async () => { fetchCalls += 1; return '9.9.9'; },
      log: (l) => lines.push(l),
    });
    assert.equal(printed, false);
    assert.equal(fetchCalls, 0);
    assert.equal(lines.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OAUTH_SWITCH_NO_UPDATE_CHECK;
    else process.env.OAUTH_SWITCH_NO_UPDATE_CHECK = prev;
  }
});

test('maybePrintUpdateNotice: never throws when the check fails', async () => {
  const cachePath = freshCachePath();
  const lines = [];
  const printed = await maybePrintUpdateNotice({
    currentVersion: '1.3.0',
    cachePath,
    now: 1,
    fetchLatest: async () => { throw new Error('offline'); },
    log: (l) => lines.push(l),
  });
  assert.equal(printed, false);
  assert.equal(lines.length, 0);
});

// --- runSelfUpdate (injected spawn, no real npm) ------------------------------

function fakeChild() {
  const handlers = {};
  return {
    on(event, cb) { handlers[event] = cb; return this; },
    emit(event, arg) { if (handlers[event]) handlers[event](arg); },
  };
}

test('runSelfUpdate: success path prints restart hint, resolves 0', async () => {
  const logs = [];
  const errs = [];
  let spawnArgs = null;
  const child = fakeChild();
  const promise = runSelfUpdate({
    spawn: (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return child; },
    log: (l) => logs.push(l),
    errorLog: (l) => errs.push(l),
  });
  // Simulate npm finishing successfully.
  child.emit('close', 0);
  const code = await promise;

  assert.equal(code, 0);
  assert.equal(spawnArgs.cmd, 'npm');
  assert.deepEqual(spawnArgs.args, ['install', '-g', 'oauth-switch@latest']);
  assert.equal(spawnArgs.opts.stdio, 'inherit');
  assert.ok(logs.some((l) => /Restart the menu bar app/.test(l)));
  assert.equal(errs.length, 0);
});

test('runSelfUpdate: npm not found (spawn ENOENT error) prints fallback command, resolves 1', async () => {
  const errs = [];
  const child = fakeChild();
  const promise = runSelfUpdate({
    spawn: () => child,
    log: () => {},
    errorLog: (l) => errs.push(l),
  });
  const enoent = new Error('spawn npm ENOENT');
  enoent.code = 'ENOENT';
  child.emit('error', enoent);
  const code = await promise;

  assert.equal(code, 1);
  assert.ok(errs.some((l) => l.includes('npm install -g oauth-switch@latest')));
  assert.ok(errs.some((l) => /not found|PATH/i.test(l)));
});

test('runSelfUpdate: EACCES suggests sudo / prefix fix, resolves 1', async () => {
  const errs = [];
  const child = fakeChild();
  const promise = runSelfUpdate({
    spawn: () => child,
    log: () => {},
    errorLog: (l) => errs.push(l),
  });
  const eacces = new Error('EACCES: permission denied');
  eacces.code = 'EACCES';
  child.emit('error', eacces);
  const code = await promise;

  assert.equal(code, 1);
  assert.ok(errs.some((l) => l.includes('sudo npm install -g oauth-switch@latest')));
  assert.ok(errs.some((l) => /prefix/i.test(l)));
});

test('runSelfUpdate: non-zero npm exit prints fallback, resolves the code', async () => {
  const errs = [];
  const child = fakeChild();
  const promise = runSelfUpdate({
    spawn: () => child,
    log: () => {},
    errorLog: (l) => errs.push(l),
  });
  child.emit('close', 7);
  const code = await promise;

  assert.equal(code, 7);
  assert.ok(errs.some((l) => l.includes('npm install -g oauth-switch@latest')));
});
