const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { refreshStoredUsageSnapshots } = require('../bin/lib/usage/format.cjs');
const { applyUsageSnapshot } = require('../bin/lib/providers/claude.cjs');

const FIXED_NOW = Date.UTC(2026, 5, 27, 12, 0, 0);
const FUTURE_ISO = new Date(FIXED_NOW + 60 * 60 * 1000).toISOString();

function account(key, accessToken, extra = {}) {
  return {
    key,
    metadata: { emailAddress: `${key}@example.com`, organizationUuid: `org-${key}` },
    credentials: { claudeAiOauth: { accessToken, refreshToken: `r-${accessToken}`, expiresAt: FIXED_NOW + 3600_000 } },
    ...extra,
  };
}

// --- refreshStoredUsageSnapshots skips cookie-backed non-current accounts ---

test('refreshStoredUsageSnapshots: non-current account with a cached cookie is NOT OAuth-fetched', async () => {
  const store = {
    accounts: [
      // current/active account (own group)
      account('cur', 'tok-cur'),
      // non-current WITH cookie, no snapshot -> would be oldest/first to fetch
      account('b', 'tok-b'),
      // non-current WITHOUT cookie, slightly newer snapshot
      account('c', 'tok-c', {
        usageSnapshot: {
          five_hour: { utilization: 5, resets_at: FUTURE_ISO },
          fetchedAt: new Date(FIXED_NOW - 40 * 60 * 1000).toISOString(),
        },
      }),
    ],
  };

  const fetched = [];
  const fetchUsage = async (token) => {
    fetched.push(token);
    // Current account is "approaching" so the non-current warm slot is spent.
    if (token === 'tok-cur') {
      return {
        five_hour: { utilization: 80, resets_at: FUTURE_ISO },
        seven_day: { utilization: 50, resets_at: FUTURE_ISO },
      };
    }
    return {
      five_hour: { utilization: 12, resets_at: FUTURE_ISO },
      seven_day: { utilization: 21, resets_at: FUTURE_ISO },
    };
  };

  const result = await refreshStoredUsageSnapshots(store, 'cur', fetchUsage, {
    now: FIXED_NOW,
    refreshOAuthToken: async () => {
      throw new Error('refreshOAuthToken must not be called in this test');
    },
    loadCookieCache: () => ({ b: { sessionKey: 'sk-ant-x', orgId: 'org-b' } }),
    getLastNonCurrentFetchAt: () => 0,
    setLastNonCurrentFetchAt: () => {},
  });

  // Current account fetched; cookie-backed 'b' never fetched; 'c' (no cookie)
  // is the spent non-current slot.
  assert.ok(fetched.includes('tok-cur'), 'current account should be fetched');
  assert.ok(fetched.includes('tok-c'), 'cookie-less non-current account should be fetched');
  assert.ok(!fetched.includes('tok-b'), 'cookie-backed account must NOT be OAuth-fetched');

  // 'b' keeps no snapshot (untouched), 'c' got a fresh one.
  assert.equal(store.accounts[1].usageSnapshot, undefined);
  assert.equal(store.accounts[2].usageSnapshot.five_hour.utilization, 12);
  assert.ok(result.changed);
});

test('refreshStoredUsageSnapshots: missing/empty cookie cache leaves OAuth behavior unchanged', async () => {
  const store = {
    accounts: [
      account('cur', 'tok-cur'),
      account('b', 'tok-b'),
    ],
  };
  const fetched = [];
  const fetchUsage = async (token) => {
    fetched.push(token);
    if (token === 'tok-cur') {
      return { five_hour: { utilization: 80, resets_at: FUTURE_ISO }, seven_day: { utilization: 50, resets_at: FUTURE_ISO } };
    }
    return { five_hour: { utilization: 9, resets_at: FUTURE_ISO } };
  };

  await refreshStoredUsageSnapshots(store, 'cur', fetchUsage, {
    now: FIXED_NOW,
    loadCookieCache: () => ({}),
    getLastNonCurrentFetchAt: () => 0,
    setLastNonCurrentFetchAt: () => {},
  });

  assert.ok(fetched.includes('tok-cur'));
  assert.ok(fetched.includes('tok-b'), 'without a cookie the non-current account is OAuth-fetched as before');
});

// --- applyUsageSnapshot (set-usage-snapshot writer) ---

function withTempStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-cookie-store-'));
  const storePath = path.join(dir, 'store.json');
  const backupDir = path.join(dir, 'backups');
  try {
    return run({ storePath, backupDir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('applyUsageSnapshot writes the snapshot + usageSource for a known key', () => {
  withTempStore(({ storePath, backupDir }) => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: '0.2.9',
      accounts: [{ key: 'acct-1', metadata: { emailAddress: 'user@example.com' } }],
    }));

    const snapshot = {
      five_hour: { utilization: 62, resets_at: FUTURE_ISO },
      seven_day: { utilization: 33, resets_at: FUTURE_ISO },
      // an extra/model field that must be dropped by the sanitizer
      seven_day_opus: { utilization: 1 },
      fetchedAt: '2026-06-27T12:00:00.000Z',
    };

    const result = applyUsageSnapshot({ storePath, backupDir, key: 'acct-1', snapshot });
    assert.equal(result.ok, true);
    assert.equal(result.index, 0);

    const written = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const entry = written.accounts[0];
    assert.equal(entry.usageSource, 'cookie');
    assert.equal(entry.usageSnapshot.five_hour.utilization, 62);
    assert.equal(entry.usageSnapshot.seven_day.utilization, 33);
    assert.equal(entry.usageSnapshot.fetchedAt, '2026-06-27T12:00:00.000Z');
    // Model-specific window is not persisted.
    assert.equal(entry.usageSnapshot.seven_day_opus, undefined);
  });
});

test('applyUsageSnapshot is a no-op for an unknown key (no store write)', () => {
  withTempStore(({ storePath, backupDir }) => {
    const original = { version: '0.2.9', accounts: [{ key: 'acct-1' }] };
    fs.writeFileSync(storePath, JSON.stringify(original));

    const result = applyUsageSnapshot({
      storePath,
      backupDir,
      key: 'missing',
      snapshot: { five_hour: { utilization: 10, resets_at: FUTURE_ISO } },
    });
    assert.equal(result.ok, false);

    const after = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.deepEqual(after, original, 'store must be unchanged for an unknown key');
  });
});
