const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const FETCH_PATH = path.join(__dirname, '..', 'bin', 'lib', 'usage', 'fetch.cjs');

// Load fetch.cjs with the `https` module swapped for a fake that records the
// request target and replays a canned response. No real network is touched.
function loadFetchWithFakeHttps(fakeHttps) {
  delete require.cache[require.resolve(FETCH_PATH)];
  const origLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'https') return fakeHttps;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(FETCH_PATH);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(FETCH_PATH)];
  }
}

function makeFakeHttps({ statusCode, responseBody }) {
  const captured = {};
  const fakeHttps = {
    get() { throw new Error('unexpected https.get in refresh test'); },
    request(url, options, cb) {
      captured.url = url;
      captured.method = options.method;
      captured.headers = options.headers;
      const res = new EventEmitter();
      res.statusCode = statusCode;
      const req = new EventEmitter();
      req.write = (body) => { captured.body = body; };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        process.nextTick(() => {
          cb(res);
          res.emit('data', responseBody);
          res.emit('end');
        });
      };
      return req;
    },
  };
  return { fakeHttps, captured };
}

test('refreshOAuthToken targets api.anthropic.com/v1/oauth/token', async () => {
  const { fakeHttps, captured } = makeFakeHttps({
    statusCode: 200,
    responseBody: JSON.stringify({
      token_type: 'Bearer',
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    }),
  });
  const { refreshOAuthToken } = loadFetchWithFakeHttps(fakeHttps);
  await refreshOAuthToken('old-refresh');

  assert.equal(captured.url, 'https://api.anthropic.com/v1/oauth/token');
  assert.equal(captured.method, 'POST');
  const sent = JSON.parse(captured.body);
  assert.equal(sent.grant_type, 'refresh_token');
  assert.equal(sent.refresh_token, 'old-refresh');
  assert.equal(sent.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
});

test('200 with expires_in + rotated refresh_token updates both fields', async () => {
  const before = Date.now();
  const { fakeHttps } = makeFakeHttps({
    statusCode: 200,
    responseBody: JSON.stringify({
      token_type: 'Bearer',
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    }),
  });
  const { refreshOAuthToken } = loadFetchWithFakeHttps(fakeHttps);
  const result = await refreshOAuthToken('old-refresh');

  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.refreshToken, 'rotated-refresh');
  // expires_in (seconds) is converted to an absolute expiresAt in ms.
  assert.ok(result.expiresAt >= before + 3600 * 1000);
  assert.ok(result.expiresAt <= Date.now() + 3600 * 1000);
});

test('400 invalid_grant rejects with inspectable statusCode', async () => {
  const { fakeHttps } = makeFakeHttps({
    statusCode: 400,
    responseBody: JSON.stringify({ error: 'invalid_grant' }),
  });
  const { refreshOAuthToken } = loadFetchWithFakeHttps(fakeHttps);
  await assert.rejects(
    () => refreshOAuthToken('dead-refresh'),
    (err) => err.statusCode === 400,
  );
});
