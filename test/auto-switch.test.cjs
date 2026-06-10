const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Persisted switch-history and state writes must never touch the real
// ~/.oauth-switch.
process.env.OAUTH_SWITCH_LOG_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-test-${process.pid}-switch.log`
);
process.env.OAUTH_SWITCH_STATE_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-test-${process.pid}-state.json`
);

// Per-test state isolation: the state path env var is read at call time.
let statePathCounter = 0;
function freshStatePath() {
  statePathCounter += 1;
  const p = path.join(
    os.tmpdir(),
    `oauth-switch-test-${process.pid}-state-${statePathCounter}.json`
  );
  process.env.OAUTH_SWITCH_STATE_PATH = p;
  return p;
}

const {
  pickBestTarget,
  pickBestCodexTarget,
  refreshCodexUsageSnapshots,
  toCodexUsageSnapshot,
  isSnapshotFresh,
  SNAPSHOT_FRESHNESS_MS,
  AUTO_SWITCH_COOLDOWN_MS,
  runAutoSwitchClaude,
  runAutoSwitchCodex,
} = require('../bin/lib/actions/auto-switch.cjs');
const { refreshStoredUsageSnapshots, NONCURRENT_REFRESH_MS } = require('../bin/lib/usage/format.cjs');
const stateStore = require('../bin/lib/store/state.cjs');
const { runSwitchAction } = require('../bin/lib/actions/switch.cjs');
const { getAccountKey } = require('../bin/lib/store/accounts.cjs');

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

  const { changed, apiThrottled } = await refreshCodexUsageSnapshots(store, null, null, fakeFetch);

  assert.deepEqual(calls, ['tok-1', 'tok-2']); // tok-1 fetched once for both org variants
  assert.equal(changed, true);
  assert.equal(apiThrottled, null);
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

  const { changed } = await refreshCodexUsageSnapshots(store, auth, currentUsage, fakeFetch);
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
  freshStatePath();
  const writes = { store: 0, live: 0 };
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

// --- Endpoint throttling (HTTP 429 from the usage API) ------------------------

function makeClaudeStore() {
  return {
    accounts: [
      {
        key: 'uuid:cur',
        metadata: { accountUuid: 'cur', emailAddress: 'cur@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'cur-token', refreshToken: 'cur-refresh' } },
      },
      {
        key: 'uuid:b',
        metadata: { accountUuid: 'b', emailAddress: 'b@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'b-token', refreshToken: 'b-refresh' } },
        usageSnapshot: snapshot(5, 5),
      },
      {
        key: 'uuid:c',
        metadata: { accountUuid: 'c', emailAddress: 'c@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'c-token', refreshToken: 'c-refresh' } },
        usageSnapshot: snapshot(30, 40),
      },
    ],
  };
}

function makeClaudeContext(overrides = {}) {
  const writes = { store: 0, live: 0, lastConfig: null };
  const ctx = {
    store: makeClaudeStore(),
    config: { oauthAccount: { accountUuid: 'cur', emailAddress: 'cur@example.com' } },
    credentials: { claudeAiOauth: { accessToken: 'cur-token', refreshToken: 'cur-refresh' } },
    options: {},
    writeStore: () => { writes.store += 1; },
    writeLiveState: (nextConfig) => { writes.live += 1; writes.lastConfig = nextConfig; },
    deepCopy: (v) => JSON.parse(JSON.stringify(v)),
    getAccountKey,
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { five_hour: { utilization: 95 }, seven_day: { utilization: 95 } },
      changed: false,
      apiThrottled: null,
    }),
    fetchUsage: async () => { throw new Error('unused'); },
    setRateLimitResetAt: () => {},
    setRateLimitResetAtFromIso: () => {},
    ensureDir: () => {},
    notify: () => {},
    ...overrides,
  };
  return { ctx, writes };
}

test('Claude 429: api_throttled skips the cycle and writes a throttle deadline', async () => {
  freshStatePath();
  const { ctx, writes } = makeClaudeContext({
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { api_throttled: true, retry_after: 600 },
      changed: false,
      apiThrottled: { retryAfter: 600 },
    }),
  });

  const before = Date.now();
  const result = await runAutoSwitchClaude(ctx);

  assert.equal(result.switched, false);
  assert.equal(writes.live, 0);
  const until = stateStore.getProviderThrottleUntil('claude');
  assert.ok(until, 'throttle deadline must be persisted');
  // retry-after 600s is shorter than the 15-minute backoff floor, so the
  // exponential backoff (streak 0 -> 15 min) wins.
  assert.ok(until >= before + 14 * 60 * 1000 && until <= Date.now() + 16 * 60 * 1000);
});

test('Claude throttle deadline suppresses all usage fetches', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);
  let refreshCalls = 0;
  const { ctx, writes } = makeClaudeContext({
    refreshStoredUsageSnapshots: async () => {
      refreshCalls += 1;
      throw new Error('must not fetch while throttled');
    },
  });

  const result = await runAutoSwitchClaude(ctx);

  assert.equal(result.switched, false);
  assert.equal(refreshCalls, 0);
  assert.equal(writes.live, 0);
});

test('Claude 429 with missing retry-after defaults to a 15 minute deadline', async () => {
  freshStatePath();
  const { ctx } = makeClaudeContext({
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { api_throttled: true, retry_after: null },
      changed: false,
      apiThrottled: { retryAfter: null },
    }),
  });

  const before = Date.now();
  await runAutoSwitchClaude(ctx);

  const until = stateStore.getProviderThrottleUntil('claude');
  assert.ok(until >= before + 14 * 60 * 1000 && until <= Date.now() + 16 * 60 * 1000);
});

test('refreshStoredUsageSnapshots fetches current first, skips fresh non-current and all-disabled groups', async () => {
  const store = {
    accounts: [
      {
        key: 'uuid:fresh',
        metadata: { accountUuid: 'fresh', emailAddress: 'fresh@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'fresh-token' } },
        usageSnapshot: snapshot(10, 10, freshAt(10 * 60 * 1000)), // 10 min old
      },
      {
        key: 'uuid:stale',
        metadata: { accountUuid: 'stale', emailAddress: 'stale@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'stale-token' } },
        usageSnapshot: snapshot(10, 10, freshAt(NONCURRENT_REFRESH_MS + 60 * 1000)),
      },
      {
        key: 'uuid:off',
        metadata: { accountUuid: 'off', emailAddress: 'off@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'off-token' } },
        disabled: true,
      },
      {
        key: 'uuid:cur',
        metadata: { accountUuid: 'cur', emailAddress: 'cur@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'cur-token' } },
        usageSnapshot: snapshot(50, 50, freshAt(60 * 1000)), // current: always refetched
      },
    ],
  };
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    return {
      five_hour: { utilization: 42, resets_at: freshAt(-3600000) },
      seven_day: { utilization: 42, resets_at: freshAt(-86400000) },
    };
  };

  const { currentUsage, apiThrottled } = await refreshStoredUsageSnapshots(store, 'uuid:cur', fakeFetch);

  // Current group first (despite being last in the store), fresh and
  // all-disabled non-current groups skipped entirely.
  assert.deepEqual(calls, ['cur-token', 'stale-token']);
  assert.equal(currentUsage.five_hour.utilization, 42);
  assert.equal(apiThrottled, null);
});

test('refreshStoredUsageSnapshots aborts remaining fetches on api_throttled and keeps old snapshots', async () => {
  const oldSnapshotB = snapshot(10, 10, freshAt(NONCURRENT_REFRESH_MS + 60 * 1000));
  const store = {
    accounts: [
      {
        key: 'uuid:cur',
        metadata: { accountUuid: 'cur', emailAddress: 'cur@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'cur-token' } },
      },
      {
        key: 'uuid:b',
        metadata: { accountUuid: 'b', emailAddress: 'b@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'b-token' } },
        usageSnapshot: JSON.parse(JSON.stringify(oldSnapshotB)),
      },
      {
        key: 'uuid:c',
        metadata: { accountUuid: 'c', emailAddress: 'c@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'c-token' } },
      },
    ],
  };
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    if (token === 'cur-token') {
      return {
        five_hour: { utilization: 95, resets_at: freshAt(-3600000) },
        seven_day: { utilization: 95, resets_at: freshAt(-86400000) },
      };
    }
    return { api_throttled: true, retry_after: 300 };
  };

  const { currentUsage, apiThrottled } = await refreshStoredUsageSnapshots(store, 'uuid:cur', fakeFetch);

  assert.deepEqual(calls, ['cur-token', 'b-token']); // c-token never fetched
  assert.deepEqual(apiThrottled, { retryAfter: 300 });
  assert.equal(currentUsage.five_hour.utilization, 95);
  assert.deepEqual(store.accounts[1].usageSnapshot, oldSnapshotB); // kept
  assert.equal(store.accounts[2].usageSnapshot, undefined);
});

test('refreshStoredUsageSnapshots reports api_throttled when the current account fetch is throttled', async () => {
  const store = makeClaudeStore();
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    return { api_throttled: true, retry_after: 1135 };
  };

  const { currentUsage, apiThrottled, changed } = await refreshStoredUsageSnapshots(store, 'uuid:cur', fakeFetch);

  assert.deepEqual(calls, ['cur-token']); // aborts immediately
  assert.deepEqual(apiThrottled, { retryAfter: 1135 });
  assert.equal(currentUsage.api_throttled, true);
  assert.equal(changed, false);
});

// --- Anti-ping-pong cooldown ---------------------------------------------------

test('cooldown blocks a second auto-switch within 15 minutes', async () => {
  freshStatePath();

  const first = makeClaudeContext();
  const firstResult = await runAutoSwitchClaude(first.ctx);
  assert.equal(firstResult.switched, true);
  assert.equal(first.writes.live, 1);

  const second = makeClaudeContext();
  const secondResult = await runAutoSwitchClaude(second.ctx);
  assert.equal(secondResult.switched, false);
  assert.equal(second.writes.live, 0);
});

test('auto-switch records provider, fromKey, toKey and timestamp', async () => {
  freshStatePath();
  const { ctx } = makeClaudeContext();
  await runAutoSwitchClaude(ctx);

  const last = stateStore.getLastAutoSwitch('claude');
  assert.equal(last.fromKey, 'uuid:cur');
  assert.equal(last.toKey, 'uuid:b'); // lowest-usage viable target
  assert.ok(Date.now() - new Date(last.at).getTime() < 5000);
});

test('cooldown expires after AUTO_SWITCH_COOLDOWN_MS', async () => {
  freshStatePath();
  stateStore.recordAutoSwitch('claude', 'uuid:b', 'uuid:cur', Date.now() - AUTO_SWITCH_COOLDOWN_MS - 60 * 1000);

  // 16 minutes after the last auto-switch: not blocked, but the switched-FROM
  // account (uuid:b, the better-scoring target) is still excluded.
  const { ctx, writes } = makeClaudeContext();
  const result = await runAutoSwitchClaude(ctx);

  assert.equal(result.switched, true);
  assert.equal(writes.lastConfig.oauthAccount.accountUuid, 'c');
});

test('pickBestTarget excludes the last-switched-from account when alternatives exist', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(5, 5) },
    { key: 'c', usageSnapshot: snapshot(30, 40) },
  ];
  const { target } = pickBestTarget(accounts, 'a', { excludeKey: 'b' });
  assert.equal(target.key, 'c');
});

test('pickBestTarget keeps the excluded account when it is the only candidate', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(5, 5) },
  ];
  const { target } = pickBestTarget(accounts, 'a', { excludeKey: 'b' });
  assert.equal(target.key, 'b');
});

test('pickBestCodexTarget honors excludeKey with fallback', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(5, 5) },
    { key: 'c', usageSnapshot: snapshot(30, 40) },
  ];
  assert.equal(pickBestCodexTarget(accounts, 'a', { excludeKey: 'b' }).target.key, 'c');
  assert.equal(
    pickBestCodexTarget([accounts[0], accounts[1]], 'a', { excludeKey: 'b' }).target.key,
    'b'
  );
});

test('manual switch clears the auto-switch cooldown', () => {
  freshStatePath();
  stateStore.recordAutoSwitch('claude', 'uuid:b', 'uuid:cur');
  assert.ok(stateStore.getLastAutoSwitch('claude'));

  const store = makeClaudeStore();
  runSwitchAction({
    selected: {
      key: 'uuid:b',
      index: 1,
      metadata: { accountUuid: 'b', emailAddress: 'b@example.com' },
      credentials: { claudeAiOauth: { accessToken: 'b-token' } },
    },
    store,
    config: { oauthAccount: { accountUuid: 'cur', emailAddress: 'cur@example.com' } },
    options: {},
    deepCopy: (v) => JSON.parse(JSON.stringify(v)),
    writeLiveState: () => {},
    writeStore: () => {},
    getDisplayAccounts: () => [],
    inferPlanType: () => 'pro',
    getPreferredDisplayName: (m) => m.emailAddress,
    getRestartNotice: () => '',
    getStoredAccountsHeading: () => '',
    formatAccountSummary: () => [],
    RESET_WINDOW_DAYS: 7,
    getRateLimitResetAt: () => null,
  });

  assert.equal(stateStore.getLastAutoSwitch('claude'), null);
});

// --- Codex endpoint throttling -------------------------------------------------

test('Codex 429: api_throttled skips the cycle and writes a throttle deadline', async () => {
  freshStatePath();
  const auth = { tokens: { access_token: 'cur-tok', id_token: 'id-cur' } };
  const store = {
    accounts: [
      { key: 'a', auth },
      { key: 'b', auth: { tokens: { access_token: 'b-tok', id_token: 'id-b' } } },
    ],
  };
  const writes = [];
  const before = Date.now();

  const result = await runAutoSwitchCodex({
    readJson: (p) => (p === 'AUTH' ? auth : store),
    writeJson: (p) => writes.push(p),
    backupFile: () => { throw new Error('must not switch'); },
    AUTH_PATH: 'AUTH',
    STORE_PATH: 'STORE',
    fetchUsage: async () => ({ api_throttled: true, retry_after: 1135 }),
    notify: () => {},
  });

  assert.equal(result.switched, false);
  assert.deepEqual(writes, []);
  const until = stateStore.getProviderThrottleUntil('codex');
  assert.ok(until >= before + 1125 * 1000 && until <= Date.now() + 1145 * 1000);
});

test('Codex throttle deadline suppresses all usage fetches', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('codex', 600);
  const auth = { tokens: { access_token: 'cur-tok', id_token: 'id-cur' } };
  const store = { accounts: [{ key: 'a', auth }, { key: 'b', auth: { tokens: { access_token: 'b-tok', id_token: 'id-b' } } }] };
  let fetchCalls = 0;

  const result = await runAutoSwitchCodex({
    readJson: (p) => (p === 'AUTH' ? auth : store),
    writeJson: () => {},
    backupFile: () => {},
    AUTH_PATH: 'AUTH',
    STORE_PATH: 'STORE',
    fetchUsage: async () => { fetchCalls += 1; return {}; },
    notify: () => {},
  });

  assert.equal(result.switched, false);
  assert.equal(fetchCalls, 0);
});

test('refreshCodexUsageSnapshots skips fresh non-current credentials and all-disabled groups', async () => {
  const store = {
    accounts: [
      {
        key: 'fresh',
        auth: { tokens: { access_token: 'tok-fresh', id_token: 'id-fresh' } },
        usageSnapshot: snapshot(10, 10, freshAt(10 * 60 * 1000)),
      },
      {
        key: 'stale',
        auth: { tokens: { access_token: 'tok-stale', id_token: 'id-stale' } },
        usageSnapshot: snapshot(10, 10, freshAt(NONCURRENT_REFRESH_MS + 60 * 1000)),
      },
      {
        key: 'off',
        auth: { tokens: { access_token: 'tok-off', id_token: 'id-off' } },
        disabled: true,
      },
    ],
  };
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    return { five_hour_percent: 12, weekly_percent: 34 };
  };

  const { apiThrottled } = await refreshCodexUsageSnapshots(store, null, null, fakeFetch);

  assert.deepEqual(calls, ['tok-stale']);
  assert.equal(apiThrottled, null);
});

test('refreshCodexUsageSnapshots aborts remaining fetches on api_throttled and keeps old snapshots', async () => {
  const oldSnapshot = snapshot(40, 40, freshAt(NONCURRENT_REFRESH_MS + 60 * 1000));
  const store = {
    accounts: [
      { key: 'one', auth: { tokens: { access_token: 'tok-1', id_token: 'id-1' } }, usageSnapshot: JSON.parse(JSON.stringify(oldSnapshot)) },
      { key: 'two', auth: { tokens: { access_token: 'tok-2', id_token: 'id-2' } } },
    ],
  };
  const calls = [];
  const fakeFetch = async (token) => {
    calls.push(token);
    return { api_throttled: true, retry_after: 300 };
  };

  const { changed, apiThrottled } = await refreshCodexUsageSnapshots(store, null, null, fakeFetch);

  assert.deepEqual(calls, ['tok-1']); // tok-2 never fetched
  assert.deepEqual(apiThrottled, { retryAfter: 300 });
  assert.equal(changed, false);
  assert.deepEqual(store.accounts[0].usageSnapshot, oldSnapshot);
  assert.equal(store.accounts[1].usageSnapshot, undefined);
});

// --- Exponential throttle backoff in the daemon ---------------------------------

// Force the persisted deadline into the past while keeping the streak, so the
// next daemon cycle gets past the gate and takes a fresh 429.
function expireProviderDeadline(provider) {
  const current = stateStore.readState();
  current.providers[provider].throttledUntil = new Date(Date.now() - 1000).toISOString();
  stateStore.writeState(current);
}

test('Claude consecutive daemon 429s double the backoff: 15 -> 30 -> 60 minutes', async () => {
  freshStatePath();
  const minute = 60 * 1000;
  const throttledContext = () => makeClaudeContext({
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { api_throttled: true, retry_after: null },
      changed: false,
      apiThrottled: { retryAfter: null },
    }),
  });

  for (const expectedMinutes of [15, 30, 60, 60]) {
    const before = Date.now();
    const result = await runAutoSwitchClaude(throttledContext().ctx);
    assert.equal(result.switched, false);
    const until = stateStore.getProviderThrottleUntil('claude');
    assert.ok(
      until >= before + (expectedMinutes - 1) * minute && until <= Date.now() + (expectedMinutes + 1) * minute,
      `expected ~${expectedMinutes} min deadline, got ${(until - before) / minute} min`
    );
    expireProviderDeadline('claude');
  }
});

test('Claude daemon honors a retry-after longer than the computed backoff', async () => {
  freshStatePath();
  const { ctx } = makeClaudeContext({
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { api_throttled: true, retry_after: 2400 },
      changed: false,
      apiThrottled: { retryAfter: 2400 }, // 40 min > 15 min backoff
    }),
  });

  const before = Date.now();
  await runAutoSwitchClaude(ctx);
  const until = stateStore.getProviderThrottleUntil('claude');
  assert.ok(until >= before + 2390 * 1000 && until <= Date.now() + 2410 * 1000);
});

test('Claude successful usage fetch resets the throttle streak', async () => {
  freshStatePath();
  // Leftover streak from an expired throttle episode.
  stateStore.setProviderThrottle('claude', null, Date.now() - 60 * 60 * 1000);
  stateStore.setProviderThrottle('claude', null, Date.now() - 40 * 60 * 1000);
  assert.equal(stateStore.getProviderThrottleStreak('claude'), 2);
  assert.equal(stateStore.getProviderThrottleUntil('claude'), null);

  const { ctx } = makeClaudeContext(); // successful usage fetch
  const result = await runAutoSwitchClaude(ctx);

  assert.equal(result.switched, true);
  assert.equal(stateStore.getProviderThrottleStreak('claude'), 0);
  // After the reset, the next 429 starts the curve over at 15 minutes.
  const now = Date.now();
  assert.equal(stateStore.setProviderThrottle('claude', null, now), now + 15 * 60 * 1000);
});

test('Codex successful usage fetch resets the throttle streak', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('codex', null, Date.now() - 60 * 60 * 1000); // expired, streak 1
  assert.equal(stateStore.getProviderThrottleStreak('codex'), 1);

  const auth = { tokens: { access_token: 'cur-tok', id_token: 'id-cur' } };
  const store = {
    accounts: [
      { key: 'a', auth },
      { key: 'b', auth: { tokens: { access_token: 'b-tok', id_token: 'id-b' } } },
    ],
  };
  const result = await runAutoSwitchCodex({
    readJson: (p) => (p === 'AUTH' ? auth : store),
    writeJson: () => {},
    backupFile: () => {},
    AUTH_PATH: 'AUTH',
    STORE_PATH: 'STORE',
    fetchUsage: async () => ({ five_hour_percent: 10, weekly_percent: 10 }),
    notify: () => {},
  });

  assert.equal(result.switched, false); // within limits
  assert.equal(stateStore.getProviderThrottleStreak('codex'), 0);
});

test('Codex consecutive daemon 429s double the backoff deadline', async () => {
  freshStatePath();
  const minute = 60 * 1000;
  const auth = { tokens: { access_token: 'cur-tok', id_token: 'id-cur' } };
  const store = {
    accounts: [
      { key: 'a', auth },
      { key: 'b', auth: { tokens: { access_token: 'b-tok', id_token: 'id-b' } } },
    ],
  };
  const runThrottledCycle = () => runAutoSwitchCodex({
    readJson: (p) => (p === 'AUTH' ? auth : store),
    writeJson: () => {},
    backupFile: () => { throw new Error('must not switch'); },
    AUTH_PATH: 'AUTH',
    STORE_PATH: 'STORE',
    fetchUsage: async () => ({ api_throttled: true, retry_after: null }),
    notify: () => {},
  });

  for (const expectedMinutes of [15, 30, 60]) {
    const before = Date.now();
    await runThrottledCycle();
    const until = stateStore.getProviderThrottleUntil('codex');
    assert.ok(
      until >= before + (expectedMinutes - 1) * minute && until <= Date.now() + (expectedMinutes + 1) * minute,
      `expected ~${expectedMinutes} min deadline, got ${(until - before) / minute} min`
    );
    expireProviderDeadline('codex');
  }
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
