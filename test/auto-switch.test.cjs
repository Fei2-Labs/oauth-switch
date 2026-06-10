const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pickBestTarget,
  pickBestCodexTarget,
  refreshCodexUsageSnapshots,
  toCodexUsageSnapshot,
  isSnapshotFresh,
  SNAPSHOT_FRESHNESS_MS,
  runAutoSwitchClaude,
} = require('../bin/lib/actions/auto-switch.cjs');
const { refreshStoredUsageSnapshots } = require('../bin/lib/usage/format.cjs');

function freshAt(msAgo = 0) {
  return new Date(Date.now() - msAgo).toISOString();
}

function snapshot(fiveH, sevenD, fetchedAt = freshAt()) {
  return {
    five_hour: { utilization: fiveH, resets_at: freshAt(-3600000) },
    seven_day: { utilization: sevenD, resets_at: freshAt(-86400000) },
    fetchedAt,
  };
}

// --- Codex target picking -------------------------------------------------

test('pickBestCodexTarget picks the lowest-usage viable account', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(90, 95) },
    { key: 'b', usageSnapshot: snapshot(50, 70) },
    { key: 'c', usageSnapshot: snapshot(10, 20) },
    { key: 'd', usageSnapshot: snapshot(30, 40) },
  ];
  const { target, forced } = pickBestCodexTarget(accounts, 'a');
  assert.equal(target.key, 'c');
  assert.equal(forced, false);
});

test('pickBestCodexTarget excludes disabled accounts', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(90, 95) },
    { key: 'b', usageSnapshot: snapshot(5, 5), disabled: true },
    { key: 'c', usageSnapshot: snapshot(30, 40) },
  ];
  const { target } = pickBestCodexTarget(accounts, 'a');
  assert.equal(target.key, 'c');
});

test('pickBestCodexTarget: over-target accounts are forced, not viable', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(70, 85) },
    { key: 'c', usageSnapshot: snapshot(65, 90) },
  ];
  const { target, forced } = pickBestCodexTarget(accounts, 'a');
  assert.equal(forced, true);
  assert.equal(target.key, 'c'); // lowest score among non-viable scored
});

test('pickBestCodexTarget falls back to oldest lastUsedAt when no snapshot data', () => {
  const accounts = [
    { key: 'a', current: true },
    { key: 'b', lastUsedAt: '2026-06-01T00:00:00Z' },
    { key: 'c', lastUsedAt: '2026-05-01T00:00:00Z' },
  ];
  const { target, forced } = pickBestCodexTarget(accounts, 'a');
  assert.equal(forced, true);
  assert.equal(target.key, 'c');
});

test('pickBestCodexTarget returns no target when only the current account exists', () => {
  const accounts = [{ key: 'a', current: true, usageSnapshot: snapshot(95, 95) }];
  const { target } = pickBestCodexTarget(accounts, 'a');
  assert.equal(target, null);
});

// --- Snapshot staleness guard ----------------------------------------------

test('stale snapshot is excluded from viable (Codex)', () => {
  const stale = snapshot(10, 20, freshAt(SNAPSHOT_FRESHNESS_MS + 60000));
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: stale },
  ];
  const { target, forced } = pickBestCodexTarget(accounts, 'a');
  assert.equal(forced, true); // eligible only for the forced path
  assert.equal(target.key, 'b');
});

test('stale snapshot is excluded from viable (Claude)', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(10, 20, freshAt(SNAPSHOT_FRESHNESS_MS + 60000)) },
    { key: 'c', usageSnapshot: snapshot(50, 50) },
  ];
  const { target, forced } = pickBestTarget(accounts, 'a');
  assert.equal(forced, false);
  assert.equal(target.key, 'c'); // fresh viable beats stale lower-usage
});

test('snapshot without fetchedAt is never fresh', () => {
  assert.equal(isSnapshotFresh({ five_hour: { utilization: 1 } }), false);
  assert.equal(isSnapshotFresh(null), false);
  assert.equal(isSnapshotFresh(snapshot(1, 1)), true);
});

// --- Codex usage refresh ----------------------------------------------------

test('refreshCodexUsageSnapshots dedupes by credential fingerprint and keeps old snapshot on failure', async () => {
  const oldSnapshot = snapshot(40, 40, freshAt(3600000));
  const store = {
    accounts: [
      { key: 'one', auth: { tokens: { access_token: 'tok-1', id_token: 'id-1' } } },
      { key: 'one-org-b', auth: { tokens: { access_token: 'tok-1', id_token: 'id-1' } } },
      { key: 'two', auth: { tokens: { access_token: 'tok-2', id_token: 'id-2' } }, usageSnapshot: oldSnapshot },
      { key: 'no-token', auth: {} },
    ],
  };
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    if (token === 'tok-2') throw new Error('boom');
    return { five_hour_percent: 12, weekly_percent: 34, five_hour_reset: freshAt(), weekly_reset: freshAt() };
  };

  const changed = await refreshCodexUsageSnapshots(store, null, null, fakeFetch);

  assert.deepEqual(calls, ['tok-1', 'tok-2']); // tok-1 fetched once for both org variants
  assert.equal(changed, true);
  assert.equal(store.accounts[0].usageSnapshot.five_hour.utilization, 12);
  assert.equal(store.accounts[1].usageSnapshot.five_hour.utilization, 12);
  assert.ok(store.accounts[0].usageSnapshot.fetchedAt);
  assert.deepEqual(store.accounts[2].usageSnapshot, oldSnapshot); // failure keeps old snapshot
  assert.equal(store.accounts[3].usageSnapshot, undefined);
});

test('refreshCodexUsageSnapshots reuses current account usage instead of refetching', async () => {
  const auth = { tokens: { access_token: 'tok-current', id_token: 'id-current' } };
  const store = { accounts: [{ key: 'cur', auth }] };
  const currentUsage = { five_hour_percent: 55, weekly_percent: 66 };
  const fakeFetch = async () => { throw new Error('should not be called'); };

  const changed = await refreshCodexUsageSnapshots(store, auth, currentUsage, fakeFetch);
  assert.equal(changed, true);
  assert.equal(store.accounts[0].usageSnapshot.five_hour.utilization, 55);
  assert.equal(store.accounts[0].usageSnapshot.seven_day.utilization, 66);
});

test('toCodexUsageSnapshot maps usage shape and stamps fetchedAt', () => {
  const snap = toCodexUsageSnapshot({ five_hour_percent: 1, weekly_percent: 2 }, '2026-06-10T00:00:00Z');
  assert.equal(snap.five_hour.utilization, 1);
  assert.equal(snap.seven_day.utilization, 2);
  assert.equal(snap.fetchedAt, '2026-06-10T00:00:00Z');
});

// --- Claude stored-token refresh ---------------------------------------------

function claudeStore() {
  const credentials = {
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    },
  };
  return {
    accounts: [
      {
        key: 'uuid:u1',
        metadata: { accountUuid: 'u1', emailAddress: 'a@example.com' },
        credentials: JSON.parse(JSON.stringify(credentials)),
      },
      {
        key: 'uuid:u1-dup',
        metadata: { accountUuid: 'u1', emailAddress: 'a@example.com' },
        credentials: JSON.parse(JSON.stringify(credentials)),
      },
    ],
  };
}

test('401 triggers OAuth refresh, retries fetch, and updates store credentials for the whole group', async () => {
  const store = claudeStore();
  const fetchCalls = [];
  const fakeFetch = async (token) => {
    fetchCalls.push(token);
    if (token === 'old-access') {
      const err = new Error('Usage API returned 401');
      err.statusCode = 401;
      throw err;
    }
    assert.equal(token, 'new-access');
    return {
      five_hour: { utilization: 11, resets_at: freshAt(-3600000) },
      seven_day: { utilization: 22, resets_at: freshAt(-86400000) },
    };
  };
  let refreshCalls = 0;
  const fakeRefresh = async (refreshToken) => {
    refreshCalls += 1;
    assert.equal(refreshToken, 'old-refresh');
    return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 999999 };
  };

  const { changed } = await refreshStoredUsageSnapshots(store, 'other-key', fakeFetch, {
    refreshOAuthToken: fakeRefresh,
  });

  assert.equal(changed, true);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(fetchCalls, ['old-access', 'new-access']);
  for (const entry of store.accounts) {
    assert.equal(entry.credentials.claudeAiOauth.accessToken, 'new-access');
    assert.equal(entry.credentials.claudeAiOauth.refreshToken, 'new-refresh');
    assert.equal(entry.credentials.claudeAiOauth.expiresAt, 999999);
    assert.equal(entry.usageSnapshot.five_hour.utilization, 11);
    assert.ok(entry.usageSnapshot.fetchedAt);
  }
});

test('failed OAuth refresh keeps old snapshot and credentials, continues silently', async () => {
  const store = claudeStore();
  const oldSnapshot = snapshot(33, 44, freshAt(3600000));
  store.accounts[0].usageSnapshot = JSON.parse(JSON.stringify(oldSnapshot));
  const fakeFetch = async () => {
    const err = new Error('Usage API returned 401');
    err.statusCode = 401;
    throw err;
  };
  const fakeRefresh = async () => { throw new Error('revoked'); };

  const { changed, currentUsage } = await refreshStoredUsageSnapshots(store, 'other-key', fakeFetch, {
    refreshOAuthToken: fakeRefresh,
  });

  assert.equal(changed, false);
  assert.equal(currentUsage, null);
  assert.equal(store.accounts[0].credentials.claudeAiOauth.accessToken, 'old-access');
  assert.deepEqual(store.accounts[0].usageSnapshot, oldSnapshot);
});

// --- Claude auto-switch sees just-refreshed snapshots -------------------------

test('runAutoSwitchClaude picks targets from snapshots written during this run', async () => {
  // Regression: display accounts must be computed AFTER the snapshot refresh.
  // The refresh replaces usageSnapshot objects, so a pre-refresh shallow copy
  // would hide just-fetched data from pickBestTarget.
  const store = {
    accounts: [
      {
        key: 'uuid:cur',
        metadata: { accountUuid: 'cur', emailAddress: 'cur@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'cur-token', refreshToken: 'cur-refresh' } },
      },
      {
        key: 'uuid:other',
        metadata: { accountUuid: 'other', emailAddress: 'other@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'other-token', refreshToken: 'other-refresh' } },
        // No usageSnapshot yet: only the in-run refresh can make it viable.
      },
    ],
  };
  const writes = { store: 0, live: 0 };
  const { getAccountKey } = require('../bin/lib/store/accounts.cjs');
  const result = await runAutoSwitchClaude({
    store,
    config: { oauthAccount: { accountUuid: 'cur', emailAddress: 'cur@example.com' } },
    credentials: { claudeAiOauth: { accessToken: 'cur-token', refreshToken: 'cur-refresh' } },
    options: {},
    writeStore: () => { writes.store += 1; },
    writeLiveState: () => { writes.live += 1; },
    deepCopy: (v) => JSON.parse(JSON.stringify(v)),
    getAccountKey,
    refreshStoredUsageSnapshots: async (s) => {
      // Simulate the real refresh: REPLACE the snapshot object on the entry.
      s.accounts[1].usageSnapshot = snapshot(10, 20);
      return {
        currentUsage: { five_hour: { utilization: 95 }, seven_day: { utilization: 95 } },
        changed: true,
      };
    },
    fetchUsage: async () => { throw new Error('unused'); },
    setRateLimitResetAt: () => {},
    setRateLimitResetAtFromIso: () => {},
    ensureDir: () => {},
    notify: () => {},
  });

  assert.equal(result.switched, true);
  assert.equal(writes.live, 1);
  assert.ok(writes.store >= 1);
});

test('non-auth fetch failure does not attempt OAuth refresh', async () => {
  const store = claudeStore();
  const fakeFetch = async () => {
    const err = new Error('Usage API returned 500');
    err.statusCode = 500;
    throw err;
  };
  let refreshCalls = 0;
  const fakeRefresh = async () => {
    refreshCalls += 1;
    return { accessToken: 'x' };
  };

  const { changed } = await refreshStoredUsageSnapshots(store, 'other-key', fakeFetch, {
    refreshOAuthToken: fakeRefresh,
  });

  assert.equal(refreshCalls, 0);
  assert.equal(changed, false);
  assert.equal(store.accounts[0].credentials.claudeAiOauth.accessToken, 'old-access');
});
