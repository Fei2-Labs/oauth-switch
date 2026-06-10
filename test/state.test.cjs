const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  THROTTLE_DEFAULT_MS,
  THROTTLE_MAX_MS,
  readState,
  writeState,
  getProviderThrottleUntil,
  setProviderThrottle,
  recordAutoSwitch,
  getLastAutoSwitch,
  clearAutoSwitchCooldown,
} = require('../bin/lib/store/state.cjs');

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-switch-state-test-'));
  return path.join(dir, 'nested', 'state.json');
}

test('missing or corrupt state file falls back to defaults', () => {
  const statePath = tmpStatePath();
  assert.deepEqual(readState(statePath), {});
  assert.equal(getProviderThrottleUntil('claude', Date.now(), statePath), null);
  assert.equal(getLastAutoSwitch('claude', statePath), null);

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, 'not json{{{', 'utf8');
  assert.deepEqual(readState(statePath), {});
  assert.equal(getProviderThrottleUntil('claude', Date.now(), statePath), null);
  assert.equal(getLastAutoSwitch('claude', statePath), null);
});

test('setProviderThrottle stores now + retry-after and is readable until the deadline', () => {
  const statePath = tmpStatePath();
  const now = Date.now();
  const until = setProviderThrottle('claude', 1135, now, statePath);

  assert.equal(until, now + 1135 * 1000);
  assert.equal(getProviderThrottleUntil('claude', now, statePath), until);
  assert.equal(getProviderThrottleUntil('claude', until + 1, statePath), null); // expired
  assert.equal(getProviderThrottleUntil('codex', now, statePath), null); // per provider
});

test('setProviderThrottle caps retry-after at 1 hour and defaults to 15 minutes', () => {
  const statePath = tmpStatePath();
  const now = Date.now();

  assert.equal(setProviderThrottle('claude', 7200, now, statePath), now + THROTTLE_MAX_MS);
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + THROTTLE_DEFAULT_MS);
  assert.equal(setProviderThrottle('claude', 0, now, statePath), now + THROTTLE_DEFAULT_MS);
  assert.equal(setProviderThrottle('claude', Number.NaN, now, statePath), now + THROTTLE_DEFAULT_MS);
});

test('recordAutoSwitch / getLastAutoSwitch / clearAutoSwitchCooldown roundtrip', () => {
  const statePath = tmpStatePath();
  const now = Date.now();
  recordAutoSwitch('claude', 'uuid:a', 'uuid:b', now, statePath);

  const last = getLastAutoSwitch('claude', statePath);
  assert.equal(last.fromKey, 'uuid:a');
  assert.equal(last.toKey, 'uuid:b');
  assert.equal(last.at, new Date(now).toISOString());
  assert.equal(getLastAutoSwitch('codex', statePath), null); // per provider

  clearAutoSwitchCooldown('claude', statePath);
  assert.equal(getLastAutoSwitch('claude', statePath), null);
});

test('state writes for one provider preserve the other provider entries', () => {
  const statePath = tmpStatePath();
  const now = Date.now();
  setProviderThrottle('claude', 600, now, statePath);
  recordAutoSwitch('codex', 'account:x', 'account:y', now, statePath);

  assert.equal(getProviderThrottleUntil('claude', now, statePath), now + 600 * 1000);
  assert.equal(getLastAutoSwitch('codex', statePath).toKey, 'account:y');
});

test('write failures are swallowed', () => {
  const statePath = tmpStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{}', 'utf8');
  // A directory cannot be created under an existing file.
  const impossible = path.join(statePath, 'sub', 'state.json');
  assert.doesNotThrow(() => writeState({ a: 1 }, impossible));
  assert.doesNotThrow(() => setProviderThrottle('claude', 60, Date.now(), impossible));
});
