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
  getProviderThrottleStreak,
  setProviderThrottle,
  resetProviderThrottle,
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
  const now = Date.now();

  // Fresh state per call: with streak 0 the backoff floor is 15 minutes.
  assert.equal(setProviderThrottle('claude', 7200, now, tmpStatePath()), now + THROTTLE_MAX_MS);
  assert.equal(setProviderThrottle('claude', null, now, tmpStatePath()), now + THROTTLE_DEFAULT_MS);
  assert.equal(setProviderThrottle('claude', 0, now, tmpStatePath()), now + THROTTLE_DEFAULT_MS);
  assert.equal(setProviderThrottle('claude', Number.NaN, now, tmpStatePath()), now + THROTTLE_DEFAULT_MS);
});

test('consecutive throttles back off exponentially: 15 -> 30 -> 60 -> 60 minutes', () => {
  const statePath = tmpStatePath();
  const minute = 60 * 1000;
  let now = Date.now();

  assert.equal(setProviderThrottle('claude', null, now, statePath), now + 15 * minute);
  assert.equal(getProviderThrottleStreak('claude', statePath), 1);

  now += 16 * minute;
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + 30 * minute);

  now += 31 * minute;
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + 60 * minute);

  now += 61 * minute;
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + 60 * minute); // capped
  assert.equal(getProviderThrottleStreak('claude', statePath), 4);
});

test('a longer retry-after beats the computed backoff, still capped at 1 hour', () => {
  const statePath = tmpStatePath();
  const now = Date.now();

  // Streak 0: backoff 15 min, retry-after 40 min is longer and wins.
  assert.equal(setProviderThrottle('claude', 2400, now, statePath), now + 2400 * 1000);
  // Streak 1: backoff 30 min, retry-after 10 min is shorter — backoff wins.
  assert.equal(setProviderThrottle('claude', 600, now, statePath), now + 30 * 60 * 1000);
  // Streak 2: retry-after 2h capped at 1h (same as the backoff cap).
  assert.equal(setProviderThrottle('claude', 7200, now, statePath), now + THROTTLE_MAX_MS);
});

test('resetProviderThrottle clears the deadline and streak; the curve restarts at 15 minutes', () => {
  const statePath = tmpStatePath();
  const now = Date.now();
  setProviderThrottle('claude', null, now, statePath);
  setProviderThrottle('claude', null, now, statePath);
  assert.equal(getProviderThrottleStreak('claude', statePath), 2);

  resetProviderThrottle('claude', statePath);
  assert.equal(getProviderThrottleStreak('claude', statePath), 0);
  assert.equal(getProviderThrottleUntil('claude', now, statePath), null);
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + THROTTLE_DEFAULT_MS);
});

test('resetProviderThrottle preserves other provider state and lastAutoSwitch', () => {
  const statePath = tmpStatePath();
  const now = Date.now();
  setProviderThrottle('claude', null, now, statePath);
  setProviderThrottle('codex', null, now, statePath);
  recordAutoSwitch('claude', 'uuid:a', 'uuid:b', now, statePath);

  resetProviderThrottle('claude', statePath);
  assert.equal(getProviderThrottleUntil('claude', now, statePath), null);
  assert.equal(getProviderThrottleUntil('codex', now, statePath), now + THROTTLE_DEFAULT_MS);
  assert.equal(getLastAutoSwitch('claude', statePath).toKey, 'uuid:b');
});

test('the streak survives an expired deadline until a success resets it', () => {
  const statePath = tmpStatePath();
  const past = Date.now() - 20 * 60 * 1000;
  setProviderThrottle('claude', null, past, statePath); // deadline already expired

  const now = Date.now();
  assert.equal(getProviderThrottleUntil('claude', now, statePath), null);
  // The next 429 still doubles: 30 minutes, not 15.
  assert.equal(setProviderThrottle('claude', null, now, statePath), now + 30 * 60 * 1000);
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
  setProviderThrottle('claude', 1200, now, statePath); // longer than the 15-min backoff floor
  recordAutoSwitch('codex', 'account:x', 'account:y', now, statePath);

  assert.equal(getProviderThrottleUntil('claude', now, statePath), now + 1200 * 1000);
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
