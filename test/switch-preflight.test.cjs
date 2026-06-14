const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Persisted switch-history and state writes must never touch the real
// ~/.oauth-switch.
process.env.OAUTH_SWITCH_LOG_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-preflight-test-${process.pid}-switch.log`
);
process.env.OAUTH_SWITCH_STATE_PATH = path.join(
  os.tmpdir(),
  `oauth-switch-preflight-test-${process.pid}-state.json`
);

const { runSwitchAction, credentialNeedsRefresh, PREFLIGHT_EXPIRY_MARGIN_MS } = require('../bin/lib/actions/switch.cjs');
const { refreshStoredUsageSnapshots } = require('../bin/lib/usage/format.cjs');
const { pickBestTarget } = require('../bin/lib/actions/auto-switch.cjs');

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

// Store with a credential group: uuid:b and its legacy-key duplicate share
// the same OAuth credentials and scope, uuid:cur is the active account.
function makeStore({ bExpiresAt } = {}) {
  const bOauth = {
    accessToken: 'b-token',
    refreshToken: 'b-refresh',
    ...(bExpiresAt !== undefined ? { expiresAt: bExpiresAt } : {}),
  };
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
        credentials: { claudeAiOauth: { ...bOauth } },
      },
      {
        key: 'email:b@example.com',
        metadata: { accountUuid: 'b', emailAddress: 'b@example.com' },
        credentials: { claudeAiOauth: { ...bOauth } },
      },
    ],
  };
}

function makeSwitchContext(store, { refreshOAuthToken, expiresAt } = {}) {
  const calls = { live: [], store: 0, refresh: 0 };
  const selectedEntry = store.accounts.find((e) => e.key === 'uuid:b');
  const context = {
    selected: {
      key: 'uuid:b',
      index: 1,
      metadata: selectedEntry.metadata,
      credentials: JSON.parse(JSON.stringify(selectedEntry.credentials)),
    },
    store,
    config: { oauthAccount: { accountUuid: 'cur', emailAddress: 'cur@example.com' } },
    options: {},
    deepCopy: (v) => JSON.parse(JSON.stringify(v)),
    writeLiveState: (cfg, creds) => { calls.live.push({ cfg, creds }); },
    writeStore: () => { calls.store += 1; },
    getDisplayAccounts: () => [],
    inferPlanType: () => 'pro',
    getPreferredDisplayName: (m) => m.emailAddress,
    getRestartNotice: () => '',
    getStoredAccountsHeading: () => '',
    formatAccountSummary: () => [],
    RESET_WINDOW_DAYS: 7,
    getRateLimitResetAt: () => null,
    refreshOAuthToken: async (token) => {
      calls.refresh += 1;
      if (!refreshOAuthToken) throw new Error('unexpected refresh call');
      return refreshOAuthToken(token);
    },
  };
  return { context, calls };
}

// --- credentialNeedsRefresh ----------------------------------------------------

test('credentialNeedsRefresh: missing, past, near-expiry need refresh; fresh does not', () => {
  const now = Date.now();
  assert.equal(credentialNeedsRefresh({}, now), true);
  assert.equal(credentialNeedsRefresh({ expiresAt: now - 1000 }, now), true);
  assert.equal(credentialNeedsRefresh({ expiresAt: now + PREFLIGHT_EXPIRY_MARGIN_MS - 1 }, now), true);
  assert.equal(credentialNeedsRefresh({ expiresAt: now + PREFLIGHT_EXPIRY_MARGIN_MS + 60000 }, now), false);
  assert.equal(credentialNeedsRefresh({ expiresAt: 'not-a-date' }, now), true);
});

// --- switch pre-flight ----------------------------------------------------------

test('preflight: expired token + refresh success switches with fresh creds and updates the group', async () => {
  const store = makeStore({ bExpiresAt: Date.now() - 1000 });
  const { context, calls } = makeSwitchContext(store, {
    refreshOAuthToken: async () => ({
      accessToken: 'b-token-NEW',
      refreshToken: 'b-refresh-NEW',
      expiresAt: Date.now() + 3600000,
    }),
  });
  // A stale marker from a previous failure must be cleared by the refresh.
  store.accounts[1].credentialStatus = 'reauth_required';
  store.accounts[2].credentialStatus = 'reauth_required';

  await runSwitchAction(context);

  assert.equal(calls.refresh, 1);
  // Live state written exactly once, with the FRESH credentials.
  assert.equal(calls.live.length, 1);
  assert.equal(calls.live[0].creds.claudeAiOauth.accessToken, 'b-token-NEW');
  // Every entry in the credential group got the fresh tokens and lost the marker.
  for (const key of ['uuid:b', 'email:b@example.com']) {
    const entry = store.accounts.find((e) => e.key === key);
    assert.equal(entry.credentials.claudeAiOauth.accessToken, 'b-token-NEW');
    assert.equal(entry.credentials.claudeAiOauth.refreshToken, 'b-refresh-NEW');
    assert.equal(entry.credentialStatus, undefined);
  }
  assert.ok(calls.store >= 1);
});

test('preflight: refresh 400 blocks the switch, marks the group, no live write', async () => {
  const store = makeStore({ bExpiresAt: Date.now() - 1000 });
  const { context, calls } = makeSwitchContext(store, {
    refreshOAuthToken: async () => {
      const err = new Error('OAuth token refresh returned 400: invalid_grant');
      err.statusCode = 400;
      throw err;
    },
  });

  await assert.rejects(
    () => runSwitchAction(context),
    (err) => {
      assert.equal(err.code, 'SWITCH_BLOCKED_REAUTH');
      assert.equal(err.printed, true);
      assert.equal(
        err.message,
        'Cannot switch: credentials for b@example.com are no longer valid. Log in with this account in Claude Code once to refresh them.'
      );
      return true;
    }
  );

  assert.equal(calls.live.length, 0);
  assert.equal(calls.store, 1);
  for (const key of ['uuid:b', 'email:b@example.com']) {
    const entry = store.accounts.find((e) => e.key === key);
    assert.equal(entry.credentialStatus, 'reauth_required');
    assert.ok(entry.credentialCheckedAt);
  }
  // Other groups stay unmarked.
  assert.equal(store.accounts[0].credentialStatus, undefined);
});

test('preflight: network error blocks the switch but does NOT mark the group', async () => {
  const store = makeStore({ bExpiresAt: Date.now() - 1000 });
  const { context, calls } = makeSwitchContext(store, {
    refreshOAuthToken: async () => { throw new Error('OAuth token refresh timeout'); },
  });

  await assert.rejects(() => runSwitchAction(context), (err) => err.printed === true);

  assert.equal(calls.live.length, 0);
  assert.equal(calls.store, 0);
  assert.equal(store.accounts[1].credentialStatus, undefined);
});

test('preflight: fresh token switches directly without any refresh call', async () => {
  const store = makeStore({ bExpiresAt: Date.now() + 3600000 });
  const { context, calls } = makeSwitchContext(store, {});

  await runSwitchAction(context);

  assert.equal(calls.refresh, 0);
  assert.equal(calls.live.length, 1);
  assert.equal(calls.live[0].creds.claudeAiOauth.accessToken, 'b-token');
});

// --- keep-alive marking in refreshStoredUsageSnapshots --------------------------

function authError(statusCode) {
  const err = new Error(`HTTP ${statusCode}`);
  err.statusCode = statusCode;
  return err;
}

test('keep-alive: 401 + refresh 400 marks the credential group', async () => {
  const store = makeStore();
  const fetchUsage = async () => { throw authError(401); };
  const refreshOAuthToken = async () => { throw authError(400); };

  const { changed } = await refreshStoredUsageSnapshots(store, 'uuid:cur', fetchUsage, { refreshOAuthToken });

  assert.equal(changed, true);
  assert.equal(store.accounts[1].credentialStatus, 'reauth_required');
  assert.equal(store.accounts[2].credentialStatus, 'reauth_required');
});

test('keep-alive: a group containing the CURRENT account is never marked reauth_required', async () => {
  const store = makeStore();
  const fetchUsage = async () => { throw authError(401); };
  const refreshOAuthToken = async () => { throw authError(400); };

  // current account is in the b group -> guard must prevent marking it dead.
  await refreshStoredUsageSnapshots(store, 'uuid:b', fetchUsage, { refreshOAuthToken });

  // The b group is the current account: never marked, regardless of other groups.
  assert.equal(store.accounts[1].credentialStatus, undefined);
  assert.equal(store.accounts[2].credentialStatus, undefined);
});

test('keep-alive: later successful fetch clears the marker', async () => {
  const store = makeStore();
  store.accounts[1].credentialStatus = 'reauth_required';
  store.accounts[1].credentialCheckedAt = freshAt();
  store.accounts[2].credentialStatus = 'reauth_required';
  store.accounts[2].credentialCheckedAt = freshAt();
  const fetchUsage = async () => ({
    five_hour: { utilization: 10, resets_at: freshAt(-3600000) },
    seven_day: { utilization: 20, resets_at: freshAt(-86400000) },
  });

  const { changed } = await refreshStoredUsageSnapshots(store, 'uuid:b', fetchUsage, {});

  assert.equal(changed, true);
  assert.equal(store.accounts[1].credentialStatus, undefined);
  assert.equal(store.accounts[2].credentialStatus, undefined);
});

test('keep-alive: refresh timeout (no statusCode) does NOT mark', async () => {
  const store = makeStore();
  const fetchUsage = async () => { throw authError(401); };
  const refreshOAuthToken = async () => { throw new Error('OAuth token refresh timeout'); };

  await refreshStoredUsageSnapshots(store, 'uuid:b', fetchUsage, { refreshOAuthToken });

  assert.equal(store.accounts[1].credentialStatus, undefined);
  assert.equal(store.accounts[2].credentialStatus, undefined);
});

// --- current-account freshness protection ---------------------------------------

test('refresh: current account is fetched FIRST and is never starved by the non-current budget', async () => {
  const store = makeStore();
  // Current account snapshot is fresh; a non-current group has the OLDEST
  // snapshot so it would win the single non-current slot. The current account
  // must still be fetched first regardless of its own snapshot freshness.
  store.accounts[0].usageSnapshot = snapshot(50, 50, freshAt(60 * 1000));
  store.accounts[1].usageSnapshot = snapshot(10, 10, freshAt(60 * 60 * 1000));
  store.accounts[2].usageSnapshot = store.accounts[1].usageSnapshot;

  const fetchOrder = [];
  const fetchUsage = async (token) => {
    fetchOrder.push(token);
    return {
      five_hour: { utilization: 1, resets_at: freshAt(-3600000) },
      seven_day: { utilization: 1, resets_at: freshAt(-86400000) },
    };
  };

  const { currentUsage } = await refreshStoredUsageSnapshots(store, 'uuid:cur', fetchUsage, {});

  // Current token fetched first.
  assert.equal(fetchOrder[0], 'cur-token');
  // Current account always produces a currentUsage result (never skipped).
  assert.ok(currentUsage);
  // At most one non-current group fetched per cycle (budget respected).
  assert.ok(fetchOrder.length <= 2);
});

// --- auto-switch exclusion -------------------------------------------------------

test('pickBestTarget excludes reauth_required accounts like disabled ones', () => {
  const accounts = [
    { key: 'a', current: true, usageSnapshot: snapshot(95, 95) },
    { key: 'b', usageSnapshot: snapshot(5, 5), credentialStatus: 'reauth_required' },
    { key: 'c', usageSnapshot: snapshot(30, 40) },
  ];
  const { target } = pickBestTarget(accounts, 'a');
  assert.equal(target.key, 'c');

  // Only a reauth_required candidate left: no target at all.
  const { target: none } = pickBestTarget([accounts[0], accounts[1]], 'a');
  assert.equal(none, null);
});
