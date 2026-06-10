const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Persisted switch-history and state writes must never touch the real
// ~/.oauth-switch.
process.env.OAUTH_SWITCH_LOG_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-usage-gate-test-${process.pid}-switch.log`
);
process.env.OAUTH_SWITCH_STATE_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-usage-gate-test-${process.pid}-state.json`
);

// Per-test state isolation: the state path env var is read at call time.
let statePathCounter = 0;
function freshStatePath() {
  statePathCounter += 1;
  const p = path.join(
    os.tmpdir(),
    `oauth-switch-usage-gate-test-${process.pid}-state-${statePathCounter}.json`
  );
  process.env.OAUTH_SWITCH_STATE_PATH = p;
  return p;
}

const { runUsageAction } = require('../bin/lib/actions/usage.cjs');
const { runListAction } = require('../bin/lib/actions/list.cjs');
const { syncUsage } = require('../bin/lib/providers/codex.cjs');
const stateStore = require('../bin/lib/store/state.cjs');
const { formatUsageInfo } = require('../bin/lib/usage/format.cjs');
const { getAccountKey } = require('../bin/lib/store/accounts.cjs');

async function withCapturedLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function freshAt(msAgo = 0) {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeUsageContext(overrides = {}) {
  const calls = { refresh: 0, storeWrites: 0 };
  const store = {
    accounts: [
      {
        key: 'uuid:cur',
        metadata: { accountUuid: 'cur', emailAddress: 'cur@example.com' },
        credentials: { claudeAiOauth: { accessToken: 'cur-token' } },
        usageSnapshot: {
          five_hour: { utilization: 41, resets_at: freshAt(-3600000) },
          seven_day: { utilization: 52, resets_at: freshAt(-86400000) },
          fetchedAt: freshAt(60000),
        },
      },
    ],
  };
  const ctx = {
    store,
    config: { oauthAccount: { accountUuid: 'cur', emailAddress: 'cur@example.com' } },
    credentials: { claudeAiOauth: { accessToken: 'cur-token' } },
    fetchUsage: async () => { throw new Error('fetchUsage must not be called directly'); },
    formatUsageInfo,
    refreshStoredUsageSnapshots: async () => {
      calls.refresh += 1;
      return {
        currentUsage: {
          five_hour: { utilization: 10, resets_at: freshAt(-3600000) },
          seven_day: { utilization: 20, resets_at: freshAt(-86400000) },
        },
        changed: false,
        apiThrottled: null,
      };
    },
    writeStore: () => { calls.storeWrites += 1; },
    options: {},
    getAccountKey,
    setRateLimitResetAt: () => {},
    setRateLimitResetAtFromIso: () => {},
    ensureDir: () => {},
    ...overrides,
  };
  return { ctx, calls };
}

// --- Claude `usage` action gate ------------------------------------------------

test('usage gate: throttled state makes zero usage fetches and renders cached data', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);

  const { ctx, calls } = makeUsageContext();
  const lines = await withCapturedLogs(() => runUsageAction(ctx));

  assert.equal(calls.refresh, 0);
  assert.ok(lines.some((l) => l.startsWith('Usage API throttled, showing cached data, next attempt at ')));
  assert.ok(lines.some((l) => l.includes('5h remaining/reset'))); // cached snapshot rendered
  assert.ok(!lines.some((l) => l.includes('Fetching usage from Claude API')));
});

test('usage gate: throttled with no cached snapshot says so without fetching', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);

  const { ctx, calls } = makeUsageContext();
  delete ctx.store.accounts[0].usageSnapshot;
  const lines = await withCapturedLogs(() => runUsageAction(ctx));

  assert.equal(calls.refresh, 0);
  assert.ok(lines.some((l) => l.includes('No cached usage data for the current account.')));
});

test('usage gate: --force bypasses the gate, fetches, and resets the streak on success', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);
  assert.equal(stateStore.getProviderThrottleStreak('claude'), 1);

  const { ctx, calls } = makeUsageContext({ options: { force: true } });
  const lines = await withCapturedLogs(() => runUsageAction(ctx));

  assert.equal(calls.refresh, 1);
  assert.ok(lines.some((l) => l.includes('Fetching usage from Claude API')));
  assert.equal(stateStore.getProviderThrottleStreak('claude'), 0);
  assert.equal(stateStore.getProviderThrottleUntil('claude'), null);
});

test('usage gate: --force hitting a 429 records the next (doubled) backoff deadline', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 60); // streak 1, gate active
  let refreshCalls = 0;
  const { ctx } = makeUsageContext({
    options: { force: true },
    refreshStoredUsageSnapshots: async () => {
      refreshCalls += 1;
      return {
        currentUsage: { api_throttled: true, retry_after: null },
        changed: false,
        apiThrottled: { retryAfter: null },
      };
    },
  });

  const before = Date.now();
  await withCapturedLogs(() => runUsageAction(ctx));

  assert.equal(refreshCalls, 1);
  const until = stateStore.getProviderThrottleUntil('claude');
  // Streak was 1 -> the new deadline is the doubled 30-minute backoff.
  assert.ok(until >= before + 29 * 60 * 1000 && until <= Date.now() + 31 * 60 * 1000);
  assert.equal(stateStore.getProviderThrottleStreak('claude'), 2);
});

test('usage: a 429 on a normal (unthrottled) run records the backoff deadline', async () => {
  freshStatePath();
  const { ctx } = makeUsageContext({
    refreshStoredUsageSnapshots: async () => ({
      currentUsage: { api_throttled: true, retry_after: 1200 },
      changed: false,
      apiThrottled: { retryAfter: 1200 },
    }),
  });

  const before = Date.now();
  await withCapturedLogs(() => runUsageAction(ctx));

  const until = stateStore.getProviderThrottleUntil('claude');
  // retry-after 20 min beats the 15-min streak-0 backoff.
  assert.ok(until >= before + 1190 * 1000 && until <= Date.now() + 1210 * 1000);
});

// --- Claude list action gate -----------------------------------------------------

function makeListContext(overrides = {}) {
  const calls = { refresh: 0 };
  const base = makeUsageContext();
  const ctx = {
    ...base.ctx,
    synced: { changed: false },
    refreshStoredUsageSnapshots: async () => {
      calls.refresh += 1;
      return { currentUsage: null, changed: false, apiThrottled: null };
    },
    formatAccountSummary: () => [],
    getDisplayAccounts: () => [],
    getListGuidance: () => [],
    getAvailableAccountsHeading: () => 'Available Claude accounts:',
    getRateLimitResetAt: () => null,
    RESET_WINDOW_DAYS: 7,
    path,
    ...overrides,
  };
  return { ctx, calls };
}

test('list gate: throttled state makes zero usage fetches and still lists accounts', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);

  const { ctx, calls } = makeListContext();
  const lines = await withCapturedLogs(() => runListAction(ctx));

  assert.equal(calls.refresh, 0);
  assert.ok(lines.some((l) => l.startsWith('Usage API throttled, showing cached data, next attempt at ')));
  assert.ok(lines.some((l) => l.includes('Available Claude accounts:')));
});

test('list gate: --force bypasses the gate', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('claude', 600);

  const { ctx, calls } = makeListContext({ options: { force: true } });
  await withCapturedLogs(() => runListAction(ctx));

  assert.equal(calls.refresh, 1);
});

// --- Codex sync-usage gate --------------------------------------------------------

function codexStore() {
  return {
    accounts: [
      {
        key: 'a',
        displayName: 'A',
        auth: { tokens: { access_token: 'tok-a' } },
        usageSnapshot: {
          five_hour: { utilization: 12, resets_at: freshAt(-3600000) },
          seven_day: { utilization: 34, resets_at: freshAt(-86400000) },
          fetchedAt: freshAt(60000),
        },
      },
      { key: 'b', displayName: 'B', auth: { tokens: { access_token: 'tok-b' } } },
    ],
  };
}

test('codex sync-usage gate: throttled state makes zero fetches and prints cached data', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('codex', 600);
  let fetchCalls = 0;
  let storeWrites = 0;

  const lines = await withCapturedLogs(() => syncUsage({
    fetchUsage: async () => { fetchCalls += 1; return {}; },
    syncAuth: () => ({ store: codexStore(), currentKey: 'a' }),
    saveStore: () => { storeWrites += 1; },
  }));

  assert.equal(fetchCalls, 0);
  assert.equal(storeWrites, 0);
  assert.ok(lines.some((l) => l.startsWith('Codex usage API throttled, showing cached data, next attempt at ')));
  assert.ok(lines.some((l) => l.includes('A: 5H:12% | 7D:34%')));
  assert.ok(lines.some((l) => l.includes('B: no cached usage')));
});

test('codex sync-usage --force fetches anyway and a 429 records the doubled deadline', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('codex', 60); // streak 1, gate active
  let fetchCalls = 0;

  const before = Date.now();
  await withCapturedLogs(() => syncUsage({
    force: true,
    fetchUsage: async () => { fetchCalls += 1; return { api_throttled: true, retry_after: null }; },
    syncAuth: () => ({ store: codexStore(), currentKey: 'a' }),
    saveStore: () => {},
  }));

  assert.equal(fetchCalls, 1);
  const until = stateStore.getProviderThrottleUntil('codex');
  // Streak was 1 -> 30-minute backoff.
  assert.ok(until >= before + 29 * 60 * 1000 && until <= Date.now() + 31 * 60 * 1000);
  assert.equal(stateStore.getProviderThrottleStreak('codex'), 2);
});

test('codex sync-usage success resets the throttle streak', async () => {
  freshStatePath();
  stateStore.setProviderThrottle('codex', null, Date.now() - 60 * 60 * 1000); // expired, streak 1
  assert.equal(stateStore.getProviderThrottleStreak('codex'), 1);

  const lines = await withCapturedLogs(() => syncUsage({
    fetchUsage: async () => ({ five_hour_percent: 10, weekly_percent: 20, five_hour_reset: freshAt(), weekly_reset: freshAt() }),
    syncAuth: () => ({ store: codexStore(), currentKey: 'a' }),
    saveStore: () => {},
  }));

  assert.ok(lines.some((l) => l.includes('Synced Codex usage for 2 account(s).')));
  assert.equal(stateStore.getProviderThrottleStreak('codex'), 0);
  assert.equal(stateStore.getProviderThrottleUntil('codex'), null);
});
