const { test } = require('node:test');
const assert = require('node:assert/strict');

const { syncStoreFromLive } = require('../bin/lib/store/accounts.cjs');

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

function storedAccount(oauth) {
  return {
    key: 'uuid:acc-1',
    metadata: { accountUuid: 'acc-1', emailAddress: 'feifei@swedexpress.com' },
    credentials: { claudeAiOauth: oauth },
  };
}

test('live with refreshToken over stored with refreshToken -> full update', () => {
  const store = { accounts: [storedAccount({ accessToken: 'old-a', refreshToken: 'old-r', expiresAt: 1 })] };
  const credentials = liveCreds({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: 2 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'new-a');
  assert.equal(oauth.refreshToken, 'new-r');
  assert.equal(oauth.expiresAt, 2);
});

test('live WITHOUT refreshToken over stored WITH -> preserve stored refreshToken, update accessToken', () => {
  const store = { accounts: [storedAccount({ accessToken: 'old-a', refreshToken: 'good-r', expiresAt: 1 })] };
  const credentials = liveCreds({ accessToken: 'new-a', expiresAt: 2 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'new-a');
  assert.equal(oauth.refreshToken, 'good-r');
  assert.equal(oauth.expiresAt, 2);
});

test('live with empty-string refreshToken over stored WITH -> preserve stored refreshToken', () => {
  const store = { accounts: [storedAccount({ accessToken: 'old-a', refreshToken: 'good-r' })] };
  const credentials = liveCreds({ accessToken: 'new-a', refreshToken: '   ' });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  assert.equal(next.accounts[0].credentials.claudeAiOauth.refreshToken, 'good-r');
});

test('live without refreshToken over stored without -> captured as-is', () => {
  const store = { accounts: [storedAccount({ accessToken: 'old-a' })] };
  const credentials = liveCreds({ accessToken: 'new-a' });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'new-a');
  assert.equal(oauth.refreshToken, undefined);
});

test('live with EMPTY accessToken over stored WITH -> preserve stored accessToken + expiresAt', () => {
  const store = { accounts: [storedAccount({ accessToken: 'good-a', refreshToken: 'good-r', expiresAt: 111 })] };
  const credentials = liveCreds({ accessToken: '', refreshToken: 'new-r', expiresAt: 0 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'good-a');
  assert.equal(oauth.expiresAt, 111);
  assert.equal(oauth.refreshToken, 'new-r');
});

test('live WITH accessToken over stored WITH -> normal capture (no regression)', () => {
  const store = { accounts: [storedAccount({ accessToken: 'old-a', refreshToken: 'old-r', expiresAt: 1 })] };
  const credentials = liveCreds({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: 2 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'new-a');
  assert.equal(oauth.expiresAt, 2);
  assert.equal(oauth.refreshToken, 'new-r');
});

test('live and stored BOTH empty accessToken -> captured as-is, refreshToken preserved', () => {
  const store = { accounts: [storedAccount({ accessToken: '', refreshToken: 'good-r' })] };
  const credentials = liveCreds({ accessToken: '', expiresAt: 0 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, '');
  assert.equal(oauth.refreshToken, 'good-r');
});

test('brand-new account with full creds -> stored fully', () => {
  const store = { accounts: [] };
  const credentials = liveCreds({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: 5 });
  const { store: next } = syncStoreFromLive(store, makeConfig(), credentials, deepCopy, STORE_VERSION);
  const oauth = next.accounts[0].credentials.claudeAiOauth;
  assert.equal(oauth.accessToken, 'new-a');
  assert.equal(oauth.refreshToken, 'new-r');
});
