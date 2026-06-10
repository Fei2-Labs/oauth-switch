const fs = require('fs');
const os = require('os');
const path = require('path');

// Small persistent runtime state for the auto-switch daemon and the CLI
// usage commands (~/.oauth-switch/state.json). Tracks, per provider:
//   - throttledUntil: usage-API endpoint throttling deadline (HTTP 429 from
//     the usage endpoint means OUR CLIENT is being throttled, not that the
//     account hit its quota). While active, auto-switch AND the usage CLI
//     paths make zero usage requests for that provider (CLI: unless --force).
//   - throttleStreak: consecutive-429 count driving the exponential backoff
//     curve 15 min -> 30 min -> 60 min (capped). A successful usage fetch
//     resets it.
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

// Consecutive-429 count for the provider's usage endpoint (0 when clean).
function getProviderThrottleStreak(provider, statePath = getStatePath()) {
  const entry = getProviderState(readState(statePath), provider);
  return Number.isInteger(entry.throttleStreak) && entry.throttleStreak > 0 ? entry.throttleStreak : 0;
}

// Records an endpoint-throttle deadline with exponential backoff on the
// consecutive-429 streak: 15 min -> 30 min -> 60 min (capped at 1h). When the
// 429 carries a retry-after LONGER than the computed backoff, the longer
// value wins (still capped at 1h). Increments the streak; a successful usage
// fetch resets it via resetProviderThrottle(). Returns the deadline (ms epoch).
function setProviderThrottle(provider, retryAfterSecs, now = Date.now(), statePath = getStatePath()) {
  const streak = getProviderThrottleStreak(provider, statePath);
  const backoffMs = Math.min(THROTTLE_DEFAULT_MS * 2 ** streak, THROTTLE_MAX_MS);
  const retryAfterMs = typeof retryAfterSecs === 'number' && Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
    ? Math.min(retryAfterSecs * 1000, THROTTLE_MAX_MS)
    : 0;
  const until = now + Math.max(backoffMs, retryAfterMs);
  updateProviderState(provider, (entry) => {
    entry.throttledUntil = new Date(until).toISOString();
    entry.throttleStreak = streak + 1;
    return entry;
  }, statePath);
  return until;
}

// A successful usage fetch ends the throttle episode: clears the deadline
// and resets the consecutive-429 streak. No-op (and no write) when clean.
function resetProviderThrottle(provider, statePath = getStatePath()) {
  const entry = getProviderState(readState(statePath), provider);
  if (!entry.throttledUntil && !entry.throttleStreak) return;
  updateProviderState(provider, (current) => {
    delete current.throttledUntil;
    delete current.throttleStreak;
    return current;
  }, statePath);
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
  getProviderThrottleStreak,
  setProviderThrottle,
  resetProviderThrottle,
  recordAutoSwitch,
  getLastAutoSwitch,
  clearAutoSwitchCooldown,
};
