const fs = require('fs');
const os = require('os');
const path = require('path');

// Small persistent runtime state for the auto-switch daemon
// (~/.oauth-switch/state.json). Tracks, per provider:
//   - throttledUntil: usage-API endpoint throttling deadline (HTTP 429 from
//     the usage endpoint means OUR CLIENT is being throttled, not that the
//     account hit its quota). While active, auto-switch makes zero usage
//     requests for that provider.
//   - lastAutoSwitch: { fromKey, toKey, at } of the last daemon-initiated
//     switch, used for the anti-ping-pong cooldown. Manual switches clear it.
// Corrupt or missing files fall back to defaults; write failures are
// swallowed so state persistence can never break a switch.

const THROTTLE_DEFAULT_MS = 15 * 60 * 1000; // no retry-after header
const THROTTLE_MAX_MS = 60 * 60 * 1000; // cap even huge retry-after values
const AUTO_SWITCH_COOLDOWN_MS = 15 * 60 * 1000;
const SWITCHED_FROM_EXCLUDE_MS = 30 * 60 * 1000;

function getStatePath() {
  // Overridable for tests / sandboxed runs so they never touch the real file.
  return process.env.OAUTH_SWITCH_STATE_PATH
    || path.join(os.homedir(), '.oauth-switch', 'state.json');
}

function readState(statePath = getStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt file: defaults.
  }
  return {};
}

function writeState(state, statePath = getStatePath()) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Never propagate state-write errors to the caller.
  }
}

function getProviderState(state, provider) {
  const providers = state.providers && typeof state.providers === 'object' ? state.providers : {};
  const entry = providers[provider];
  return entry && typeof entry === 'object' ? entry : {};
}

function updateProviderState(provider, mutate, statePath = getStatePath()) {
  const state = readState(statePath);
  if (!state.providers || typeof state.providers !== 'object') state.providers = {};
  const entry = getProviderState(state, provider);
  state.providers[provider] = mutate(entry) || entry;
  writeState(state, statePath);
  return state.providers[provider];
}

// Returns the throttle deadline (ms epoch) when the provider's usage API is
// currently endpoint-throttled, otherwise null.
function getProviderThrottleUntil(provider, now = Date.now(), statePath = getStatePath()) {
  const entry = getProviderState(readState(statePath), provider);
  if (!entry.throttledUntil) return null;
  const until = new Date(entry.throttledUntil).getTime();
  if (Number.isNaN(until) || until <= now) return null;
  return until;
}

// Records an endpoint-throttle deadline: now + retry-after (capped at 1h),
// or 15 minutes when the header was missing. Returns the deadline (ms epoch).
function setProviderThrottle(provider, retryAfterSecs, now = Date.now(), statePath = getStatePath()) {
  const durationMs = typeof retryAfterSecs === 'number' && Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
    ? Math.min(retryAfterSecs * 1000, THROTTLE_MAX_MS)
    : THROTTLE_DEFAULT_MS;
  const until = now + durationMs;
  updateProviderState(provider, (entry) => {
    entry.throttledUntil = new Date(until).toISOString();
    return entry;
  }, statePath);
  return until;
}

// Records a daemon-initiated switch for the anti-ping-pong cooldown.
function recordAutoSwitch(provider, fromKey, toKey, now = Date.now(), statePath = getStatePath()) {
  updateProviderState(provider, (entry) => {
    entry.lastAutoSwitch = {
      fromKey: fromKey || null,
      toKey: toKey || null,
      at: new Date(now).toISOString(),
    };
    return entry;
  }, statePath);
}

// Returns { fromKey, toKey, at } of the last auto switch, or null.
function getLastAutoSwitch(provider, statePath = getStatePath()) {
  const entry = getProviderState(readState(statePath), provider);
  const last = entry.lastAutoSwitch;
  if (!last || typeof last !== 'object' || !last.at) return null;
  if (Number.isNaN(new Date(last.at).getTime())) return null;
  return last;
}

// Manual switches express user intent and reset the auto-switch cooldown.
function clearAutoSwitchCooldown(provider, statePath = getStatePath()) {
  updateProviderState(provider, (entry) => {
    delete entry.lastAutoSwitch;
    return entry;
  }, statePath);
}

module.exports = {
  THROTTLE_DEFAULT_MS,
  THROTTLE_MAX_MS,
  AUTO_SWITCH_COOLDOWN_MS,
  SWITCHED_FROM_EXCLUDE_MS,
  getStatePath,
  readState,
  writeState,
  getProviderThrottleUntil,
  setProviderThrottle,
  recordAutoSwitch,
  getLastAutoSwitch,
  clearAutoSwitchCooldown,
};
