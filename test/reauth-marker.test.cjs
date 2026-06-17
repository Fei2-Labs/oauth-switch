const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  syncStoreFromLive,
  getDisplayAccounts,
  hasStaleReauthMarker,
} = require('../bin/lib/store/accounts.cjs');

const deepCopy = (value) => JSON.parse(JSON.stringify(value));
const STORE_VERSION = 1;

function makeConfig() {
  return {
    oauthAccount: { accountUuid: 'acc-1', emailAddress: 'feifei@swedexpress.com' },
  };
}

function liveCreds(oauth) {
  return { claudeAiOauth: oauth };
}

function storedAccount(oauth, extra = {}) {
  return {
    key: 'uuid:acc-1',
    metadata: { accountUuid: 'acc-1', emailAddress: 'feifei@swedexpress.com' },
    credentials: { claudeAiOauth: oauth },
    ...extra,
  };
}

const FUTURE = Date.now() + 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;

// --- syncStoreFromLive clears reauth marker ---

test('syncStoreFromLive clears pre-existing reauth_required marker on the active entry', () => {
  const store = {
    accounts: [
      storedAccount(
        { accessToken: 'old-a', refreshToken: 'old-r', expiresAt: 1 },
        { credentialStatus: 'reauth_required', credentialCheckedAt: '2026-06-10T00:00:00.000Z' }
      ),
    ],
  };
  const credentials = liveCreds({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: 2 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const entry = next.accounts[0];
  assert.equal(entry.credentialStatus, undefined);
  assert.equal(entry.credentialCheckedAt, undefined);
});

test('syncStoreFromLive preserves stored refreshToken AND clears reauth marker in the merge path', () => {
  const store = {
    accounts: [
      storedAccount(
        { accessToken: 'old-a', refreshToken: 'good-r', expiresAt: 1 },
        { credentialStatus: 'reauth_required', credentialCheckedAt: '2026-06-10T00:00:00.000Z' }
      ),
    ],
  };
  // Live creds lack a refreshToken -> must keep the stored one.
  const credentials = liveCreds({ accessToken: 'new-a', expiresAt: 2 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const entry = next.accounts[0];
  assert.equal(entry.credentials.claudeAiOauth.accessToken, 'new-a');
  assert.equal(entry.credentials.claudeAiOauth.refreshToken, 'good-r');
  assert.equal(entry.credentialStatus, undefined);
  assert.equal(entry.credentialCheckedAt, undefined);
});

// --- hasStaleReauthMarker ---

test('hasStaleReauthMarker: reauth_required + future expiresAt (ms) -> true', () => {
  const entry = storedAccount({ accessToken: 'a', expiresAt: FUTURE }, { credentialStatus: 'reauth_required' });
  assert.equal(hasStaleReauthMarker(entry), true);
});

test('hasStaleReauthMarker: reauth_required + future expiresAt (ISO string) -> true', () => {
  const entry = storedAccount(
    { accessToken: 'a', expiresAt: new Date(FUTURE).toISOString() },
    { credentialStatus: 'reauth_required' }
  );
  assert.equal(hasStaleReauthMarker(entry), true);
});

test('hasStaleReauthMarker: reauth_required + past expiresAt -> false (genuinely needs reauth)', () => {
  const entry = storedAccount({ accessToken: 'a', expiresAt: PAST }, { credentialStatus: 'reauth_required' });
  assert.equal(hasStaleReauthMarker(entry), false);
});

test('hasStaleReauthMarker: reauth_required + no expiresAt -> false', () => {
  const entry = storedAccount({ accessToken: 'a' }, { credentialStatus: 'reauth_required' });
  assert.equal(hasStaleReauthMarker(entry), false);
});

test('hasStaleReauthMarker: no marker -> false', () => {
  const entry = storedAccount({ accessToken: 'a', expiresAt: FUTURE });
  assert.equal(hasStaleReauthMarker(entry), false);
});

// --- getDisplayAccounts surfaces non-reauth state for stale marker ---

test('getDisplayAccounts strips a stale reauth marker (future expiresAt) from the display entry', () => {
  const store = {
    accounts: [
      storedAccount(
        { accessToken: 'a', refreshToken: 'r', expiresAt: FUTURE },
        { credentialStatus: 'reauth_required', credentialCheckedAt: '2026-06-10T00:00:00.000Z' }
      ),
    ],
  };
  const [display] = getDisplayAccounts(store, null, null);
  assert.equal(display.credentialStatus, undefined);
  assert.equal(display.credentialCheckedAt, undefined);
});

test('getDisplayAccounts keeps a genuine reauth marker (past expiresAt) on the display entry', () => {
  const store = {
    accounts: [
      storedAccount(
        { accessToken: 'a', refreshToken: 'r', expiresAt: PAST },
        { credentialStatus: 'reauth_required', credentialCheckedAt: '2026-06-10T00:00:00.000Z' }
      ),
    ],
  };
  const [display] = getDisplayAccounts(store, null, null);
  assert.equal(display.credentialStatus, 'reauth_required');
});
