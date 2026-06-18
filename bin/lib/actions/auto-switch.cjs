const { execSync } = require('child_process');
const path = require('path');

const THRESHOLDS = {
  trigger5h: 80,
  trigger7d: 90,
  target5h: 60,
  target7d: 80,
};

const { getDisplayAccounts } = require('../store/accounts.cjs');
const { logEvent, formatLine } = require('../log.cjs');
const state = require('../store/state.cjs');
const {
  NONCURRENT_REFRESH_MS,
  NON_CURRENT_MIN_INTERVAL_MS,
  isSnapshotFresherThan,
  effectiveWindowUtilization,
} = require('../usage/format.cjs');

const { AUTO_SWITCH_COOLDOWN_MS, SWITCHED_FROM_EXCLUDE_MS } = state;

// Timestamped console line for the launchd stdout log (/tmp/oauth-switch-auto.log).
// persist=true additionally appends the line to the persistent history file
// (~/.oauth-switch/switch.log): every actual switch and every "no viable
// target / staying put / all at capacity" decision is persisted; routine
// "within limits" and transient-failure lines stay console-only.
function autoLog(message, { persist = false } = {}) {
  console.log(persist ? logEvent('auto', message) : formatLine('auto', message));
}

function notify(title, message) {
  const escaped = message.replace(/"/g, '\\"');
  const titleEsc = title.replace(/"/g, '\\"');
  try {
    execSync(
      `osascript -e 'display notification "${escaped}" with title "${titleEsc}"'`,
      { stdio: 'ignore' }
    );
  } catch (_) {}
}

function shouldTrigger(usage) {
  if (!usage) return false;
  // Endpoint throttling (HTTP 429 from the usage API) is OUR polling being
  // throttled, never an account signal — it must not trigger a switch.
  if (usage.api_throttled) return false;
  // A genuine rate_limited flag from a parsed 200 body is an account signal.
  if (usage.rate_limited) return true;
  const fiveH = usage.five_hour?.utilization;
  const sevenD = usage.seven_day?.utilization;
  if (typeof fiveH === 'number' && fiveH >= THRESHOLDS.trigger5h) return true;
  if (typeof sevenD === 'number' && sevenD >= THRESHOLDS.trigger7d) return true;
  return false;
}

// Snapshots older than this never count as "viable" — they may hide an
// account that exhausted its quota since the last refresh. Stale-snapshot
// accounts remain eligible only for the forced (rate-limited) path.
const SNAPSHOT_FRESHNESS_MS = 2 * 60 * 60 * 1000;

function isSnapshotFresh(usageSnapshot, now = Date.now()) {
  if (!usageSnapshot || !usageSnapshot.fetchedAt) return false;
  const fetched = new Date(usageSnapshot.fetchedAt).getTime();
  if (Number.isNaN(fetched)) return false;
  return now - fetched <= SNAPSHOT_FRESHNESS_MS;
}

function isTargetViable(usageSnapshot) {
  if (!usageSnapshot) return false;
  if (!isSnapshotFresh(usageSnapshot)) return false;
  const fiveH = usageSnapshot.five_hour?.utilization;
  const sevenD = usageSnapshot.seven_day?.utilization;
  if (typeof fiveH !== 'number' || typeof sevenD !== 'number') return false;
  return fiveH < THRESHOLDS.target5h && sevenD < THRESHOLDS.target7d;
}

// Anti-ping-pong: drop the account we last auto-switched FROM, unless it is
// the only candidate left.
function applyExcludeKey(candidates, excludeKey) {
  if (!excludeKey) return candidates;
  const without = candidates.filter((a) => a.key !== excludeKey);
  return without.length > 0 ? without : candidates;
}

function pickBestTarget(accounts, currentKey, pickOptions = {}) {
  const candidates = applyExcludeKey(
    // reauth_required credentials would strand Claude Code on /login if
    // switched to — exclude them at the same tier as disabled accounts.
    accounts.filter((a) => !a.current && a.key !== currentKey && a.usageSnapshot && !a.disabled
      && a.credentialStatus !== 'reauth_required'),
    pickOptions.excludeKey
  )
    .map((a) => ({
      ...a,
      viable: isTargetViable(a.usageSnapshot),
      score: getScore(a.usageSnapshot),
    }))
    .sort((a, b) => a.score - b.score);

  const viable = candidates.filter((c) => c.viable);
  if (viable.length > 0) return { target: viable[0], forced: false };

  if (candidates.length > 0) return { target: candidates[0], forced: true };
  return { target: null, forced: false };
}

function getScore(snapshot) {
  // Reset-aware: a window whose resets_at already passed HAS reset since the
  // snapshot was taken, so it scores as 0 utilization — but ONLY when the
  // snapshot is fresh. A stale snapshot's reset window may have been refilled
  // to 100%, so it scores from the RAW last-known value (effectiveWindowUtilization
  // gates the zeroing on snapshot freshness). The 2h viability gate is unaffected.
  const fiveH = effectiveWindowUtilization(snapshot?.five_hour, snapshot?.fetchedAt) ?? 100;
  const sevenD = effectiveWindowUtilization(snapshot?.seven_day, snapshot?.fetchedAt) ?? 100;
  return fiveH * 0.6 + sevenD * 0.4;
}

function hasUsageData(snapshot) {
  if (!snapshot) return false;
  return typeof snapshot.five_hour?.utilization === 'number'
    || typeof snapshot.seven_day?.utilization === 'number';
}

// Quota-aware Codex target picking, aligned with the Claude path:
// 1. Viable (fresh snapshot, both windows under targets) → lowest score.
// 2. No viable but snapshot data exists → forced, lowest score.
// 3. No snapshot data at all → forced, oldest lastUsedAt (legacy behavior),
//    so a failed refresh never regresses to "no target at all".
function pickBestCodexTarget(accounts, currentKey, pickOptions = {}) {
  const candidates = applyExcludeKey(
    accounts.filter((a) => !a.current && a.key !== currentKey && !a.disabled),
    pickOptions.excludeKey
  );

  const scored = candidates
    .filter((a) => hasUsageData(a.usageSnapshot))
    .map((a) => ({
      ...a,
      viable: isTargetViable(a.usageSnapshot),
      score: getScore(a.usageSnapshot),
    }))
    .sort((a, b) => a.score - b.score);

  const viable = scored.filter((c) => c.viable);
  if (viable.length > 0) return { target: viable[0], forced: false };
  if (scored.length > 0) return { target: scored[0], forced: true };

  const fallback = candidates.slice().sort((a, b) => {
    const aMs = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bMs = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return aMs - bMs;
  });
  if (fallback.length > 0) return { target: fallback[0], forced: true };
  return { target: null, forced: false };
}

function toCodexUsageSnapshot(usage, fetchedAt = new Date().toISOString()) {
  return {
    five_hour: typeof usage.five_hour_percent === 'number' || usage.five_hour_reset ? {
      utilization: usage.five_hour_percent,
      resets_at: usage.five_hour_reset ?? null,
    } : null,
    seven_day: typeof usage.weekly_percent === 'number' || usage.weekly_reset ? {
      utilization: usage.weekly_percent,
      resets_at: usage.weekly_reset ?? null,
    } : null,
    fetchedAt,
  };
}

// Refresh usage snapshots for stored Codex accounts, deduped by credential
// fingerprint so the same token is not fetched twice for org variants.
// Non-current credentials are only refetched when their snapshot is missing
// or older than NONCURRENT_REFRESH_MS, and at most ONE non-current credential
// group is fetched per cycle — the eligible one with the OLDEST snapshot
// (missing counts as oldest), yielding a natural round-robin. Fully disabled
// credential groups are never fetched (they can't be targets). Per-account
// fetch failures keep the old snapshot. An api_throttled response (endpoint
// throttling) aborts all remaining fetches immediately.
// Returns { changed, apiThrottled }.
async function refreshCodexUsageSnapshots(store, currentAuth, currentUsage, fetchUsageFn = fetchCodexUsage, now = Date.now()) {
  const { getCodexCredentialFingerprint } = require('../providers/codex-identity.cjs');
  // Non-current warming is rate-limited to once per 15 min so a chronically
  // high-usage active account doesn't poll a non-current group every cycle and
  // trip the usage-endpoint rate limit. EXCEPTION: a genuinely rate_limited
  // current account must switch NOW, so it bypasses the interval.
  const currentRateLimited = currentUsage?.rate_limited === true;
  const lastNonCurrentFetchAt = state.getLastNonCurrentFetchAt('codex');
  const intervalElapsed = now - lastNonCurrentFetchAt >= NON_CURRENT_MIN_INTERVAL_MS;
  const allowNonCurrent = currentRateLimited || intervalElapsed;
  const usageByFingerprint = new Map();
  const currentFingerprint = currentAuth ? getCodexCredentialFingerprint(currentAuth) : null;
  if (currentFingerprint && currentUsage) {
    usageByFingerprint.set(currentFingerprint, currentUsage);
  }

  const fingerprintOf = (entry) => getCodexCredentialFingerprint(entry.auth) || `entry:${entry.key}`;
  const entriesByFingerprint = new Map();
  for (const entry of store.accounts || []) {
    if (!entry?.auth?.tokens?.access_token) continue;
    const fingerprint = fingerprintOf(entry);
    if (!entriesByFingerprint.has(fingerprint)) entriesByFingerprint.set(fingerprint, []);
    entriesByFingerprint.get(fingerprint).push(entry);
  }

  // Request budget: at most ONE non-current credential group is fetched per
  // cycle — the eligible one with the OLDEST snapshot across its org variants
  // (missing snapshot counts as oldest). Round-robin emerges over cycles.
  const snapshotMs = (snapshot) => {
    if (!snapshot || !snapshot.fetchedAt) return 0;
    const ms = new Date(snapshot.fetchedAt).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  };
  const fetchCandidates = [];
  for (const [fingerprint, groupEntries] of entriesByFingerprint) {
    if (usageByFingerprint.has(fingerprint)) continue;
    // Fully disabled credential groups can never be switch targets.
    if (groupEntries.every((e) => e.disabled)) continue;
    // Recent-enough snapshot on any org variant: skip the refetch.
    if (groupEntries.some((e) => isSnapshotFresherThan(e.usageSnapshot, NONCURRENT_REFRESH_MS, now))) continue;
    const newestMs = groupEntries.reduce((max, e) => Math.max(max, snapshotMs(e.usageSnapshot)), 0);
    fetchCandidates.push({ fingerprint, newestMs });
  }
  fetchCandidates.sort((a, b) => a.newestMs - b.newestMs);
  const allowedFetchFingerprint = allowNonCurrent && fetchCandidates.length > 0
    ? fetchCandidates[0].fingerprint
    : null;

  let changed = false;
  let apiThrottled = null;
  let nonCurrentFetched = false;
  const nowIso = new Date(now).toISOString();
  for (const [index, entry] of (store.accounts || []).entries()) {
    const accessToken = entry?.auth?.tokens?.access_token;
    if (!accessToken) continue;
    const fingerprint = fingerprintOf(entry);
    if (!usageByFingerprint.has(fingerprint)) {
      if (fingerprint !== allowedFetchFingerprint) continue;
      nonCurrentFetched = true;
      try {
        const fetched = await fetchUsageFn(accessToken);
        if (fetched?.api_throttled) {
          // Endpoint throttling of this machine: abort all remaining fetches
          // immediately and keep the old snapshots.
          apiThrottled = { retryAfter: fetched.retry_after ?? null };
          break;
        }
        usageByFingerprint.set(fingerprint, fetched);
      } catch {
        // Keep the old snapshot for this credential; continue with the rest.
        usageByFingerprint.set(fingerprint, null);
      }
    }
    const usage = usageByFingerprint.get(fingerprint);
    if (!usage || usage.api_throttled) continue;
    const snapshot = toCodexUsageSnapshot(usage, nowIso);
    if (!snapshot.five_hour && !snapshot.seven_day) continue;
    const before = JSON.stringify(store.accounts[index].usageSnapshot || null);
    if (before !== JSON.stringify(snapshot)) {
      store.accounts[index].usageSnapshot = snapshot;
      changed = true;
    }
  }
  // Record the 15-min interval only when a non-current group was actually
  // fetched, so the next ~15 min skip the warm (unless rate_limited bypasses).
  if (nonCurrentFetched) state.setLastNonCurrentFetchAt('codex', now);
  return { changed, apiThrottled };
}

// Cooldown gate for daemon-initiated switches: blocks a second auto-switch
// within AUTO_SWITCH_COOLDOWN_MS, and exposes the key we last switched FROM
// (within SWITCHED_FROM_EXCLUDE_MS) so target picking can deprioritize it.
function getAutoSwitchCooldown(provider, now = Date.now()) {
  const last = state.getLastAutoSwitch(provider);
  if (!last) return { blocked: false, excludeKey: null };
  const at = new Date(last.at).getTime();
  if (Number.isNaN(at) || at > now) return { blocked: false, excludeKey: null };
  const age = now - at;
  return {
    blocked: age < AUTO_SWITCH_COOLDOWN_MS,
    excludeKey: age < SWITCHED_FROM_EXCLUDE_MS ? (last.fromKey || null) : null,
  };
}

function formatTime(msEpoch) {
  return new Date(msEpoch).toLocaleTimeString();
}

function throttleRetrySecs(untilMs, now = Date.now()) {
  return Math.max(0, Math.round((untilMs - now) / 1000));
}

async function runAutoSwitchClaude(context) {
  const {
    store,
    config,
    credentials,
    options,
    writeStore,
    writeLiveState,
    deepCopy,
    getAccountKey,
    refreshStoredUsageSnapshots,
    fetchUsage,
    setRateLimitResetAt,
    setRateLimitResetAtFromIso,
    ensureDir,
    notify: sendNotification = notify,
  } = context;

  const currentKey = getAccountKey(config.oauthAccount);
  const accessToken = credentials?.claudeAiOauth?.accessToken;

  if (!accessToken) {
    autoLog('No access token for current Claude account.');
    return { switched: false };
  }

  // Endpoint-throttle gate: while active, this run makes ZERO usage requests
  // for Claude. Console-only — this fires every cycle until the deadline.
  const throttledUntil = state.getProviderThrottleUntil('claude');
  if (throttledUntil) {
    autoLog(`Claude usage API throttled, next attempt at ${formatTime(throttledUntil)}.`);
    return { switched: false };
  }

  let currentUsage;
  let refreshThrottled = null;
  try {
    const { currentUsage: usage, changed, apiThrottled } = await refreshStoredUsageSnapshots(
      store,
      currentKey,
      (token) => fetchUsage(token, {
        setRateLimitResetAt: (secs) => setRateLimitResetAt(secs, ensureDir),
        setRateLimitResetAtFromIso: (iso) => setRateLimitResetAtFromIso(iso, ensureDir),
      })
    );
    if (changed) writeStore(store, options);
    currentUsage = usage;
    refreshThrottled = apiThrottled;
  } catch (err) {
    autoLog(`Failed to fetch usage: ${err.message}`);
    return { switched: false };
  }

  if (!refreshThrottled && currentUsage && !currentUsage.api_throttled) {
    // Successful usage fetch: end any throttle episode and reset the
    // consecutive-429 backoff streak so the next 429 starts at 15 minutes.
    state.resetProviderThrottle('claude');
  }

  if (refreshThrottled) {
    // HTTP 429 from the usage endpoint = OUR client is being throttled, not
    // an account limit. Never switch on it; back off instead (exponential:
    // 15 -> 30 -> 60 min on consecutive 429s).
    const until = state.setProviderThrottle('claude', refreshThrottled.retryAfter);
    if (currentUsage?.api_throttled || !currentUsage) {
      autoLog(`Claude usage API throttled, skipping cycle (retry in ${throttleRetrySecs(until)}s).`, { persist: true });
      return { switched: false };
    }
    // Current account usage was fetched before the throttle hit; continue
    // this cycle on existing snapshots, future cycles honor the deadline.
    autoLog(`Claude usage API throttled during snapshot refresh; pausing usage checks until ${formatTime(until)}.`);
  }

  if (!shouldTrigger(currentUsage)) {
    autoLog('Claude Code usage within limits. No switch needed.');
    return { switched: false };
  }

  // Anti-ping-pong cooldown for daemon-initiated switches.
  const cooldown = getAutoSwitchCooldown('claude');
  if (cooldown.blocked) {
    autoLog('Claude auto-switch cooldown active, skipping switch.', { persist: true });
    return { switched: false };
  }

  // Compute display accounts AFTER the snapshot refresh: the refresh replaces
  // usageSnapshot objects on the store entries, so a pre-refresh shallow copy
  // would still hold the stale snapshots and pickBestTarget would run blind.
  const accounts = getDisplayAccounts(store, config.oauthAccount, credentials);
  const isRateLimited = currentUsage?.rate_limited === true;
  const { target, forced } = pickBestTarget(accounts, currentKey, { excludeKey: cooldown.excludeKey });

  if (!target) {
    sendNotification('OAuth Switch', 'All Claude accounts at capacity. No switch possible.');
    autoLog('All Claude accounts at capacity. No switch possible.', { persist: true });
    return { switched: false };
  }

  if (forced && !isRateLimited) {
    sendNotification('OAuth Switch', 'Claude usage high, but no viable target. Staying put.');
    autoLog('Claude usage high, but no viable target. Staying put.', { persist: true });
    return { switched: false };
  }

  const now = new Date().toISOString();
  const storeIdx = store.accounts.findIndex((e) => e.key === target.key);
  if (storeIdx >= 0) store.accounts[storeIdx].lastUsedAt = now;

  const nextConfig = deepCopy(config);
  nextConfig.oauthAccount = deepCopy(target.metadata);
  const nextCredentials = deepCopy(target.credentials);

  writeLiveState(nextConfig, nextCredentials, options);
  writeStore(store, options);
  state.recordAutoSwitch('claude', currentKey, target.key);

  const name = target.metadata?.emailAddress || target.key;
  const reason = isRateLimited ? 'rate limited' : 'usage threshold exceeded';
  sendNotification('OAuth Switch', `Claude switched to ${name} (${reason}). Restart to apply.`);
  autoLog(`Switched Claude to ${name} (${reason}).`, { persist: true });
  return { switched: true };
}

async function runAutoSwitchCodex(context) {
  const {
    readJson,
    writeJson,
    backupFile,
    AUTH_PATH,
    STORE_PATH,
    fetchUsage: fetchUsageFn = fetchCodexUsage,
    notify: sendNotification = notify,
  } = context;
  const { getCodexAccountKey, getDisplayCodexAccounts } = require('../providers/codex-identity.cjs');

  const auth = readJson(AUTH_PATH);
  if (!auth || !auth.tokens?.access_token) {
    autoLog('No Codex OAuth session found.');
    return { switched: false };
  }

  const store = readJson(STORE_PATH) || { version: '1.0.0', accounts: [] };
  if (store.accounts.length < 2) {
    autoLog('Only one Codex account stored. Nothing to switch to.');
    return { switched: false };
  }

  // Endpoint-throttle gate: while active, this run makes ZERO usage requests
  // for Codex. Console-only — this fires every cycle until the deadline.
  const throttledUntil = state.getProviderThrottleUntil('codex');
  if (throttledUntil) {
    autoLog(`Codex usage API throttled, next attempt at ${formatTime(throttledUntil)}.`);
    return { switched: false };
  }

  let currentUsage;
  try {
    currentUsage = await fetchUsageFn(auth.tokens.access_token);
  } catch (err) {
    autoLog(`Failed to fetch Codex usage: ${err.message}`);
    return { switched: false };
  }

  if (currentUsage?.api_throttled) {
    // HTTP 429 from the usage endpoint = OUR client is being throttled, not
    // an account limit. Never switch on it; back off instead (exponential:
    // 15 -> 30 -> 60 min on consecutive 429s).
    const until = state.setProviderThrottle('codex', currentUsage.retry_after);
    autoLog(`Codex usage API throttled, skipping cycle (retry in ${throttleRetrySecs(until)}s).`, { persist: true });
    return { switched: false };
  }

  // Successful usage fetch: end any throttle episode and reset the
  // consecutive-429 backoff streak so the next 429 starts at 15 minutes.
  state.resetProviderThrottle('codex');

  if (!shouldTriggerCodex(currentUsage)) {
    autoLog('Codex usage within limits. No switch needed.');
    return { switched: false };
  }

  // Anti-ping-pong cooldown for daemon-initiated switches.
  const cooldown = getAutoSwitchCooldown('codex');
  if (cooldown.blocked) {
    autoLog('Codex auto-switch cooldown active, skipping switch.', { persist: true });
    return { switched: false };
  }

  const currentKey = getCodexAccountKey(auth);

  // Refresh stored accounts' usage before picking (non-current credentials
  // only when their snapshot is missing or stale), so target selection never
  // runs on blind data.
  const { changed: snapshotsChanged, apiThrottled } = await refreshCodexUsageSnapshots(store, auth, currentUsage, fetchUsageFn);
  if (apiThrottled) {
    const until = state.setProviderThrottle('codex', apiThrottled.retryAfter);
    autoLog(`Codex usage API throttled during snapshot refresh; pausing usage checks until ${formatTime(until)}.`);
  }
  if (snapshotsChanged) {
    store.updatedAt = new Date().toISOString();
    writeJson(STORE_PATH, store);
  }

  const accounts = getDisplayCodexAccounts(store, auth);
  const isRateLimited = currentUsage?.rate_limited === true;
  const { target, forced } = pickBestCodexTarget(accounts, currentKey, { excludeKey: cooldown.excludeKey });

  if (!target) {
    sendNotification('OAuth Switch', 'All Codex accounts at capacity.');
    autoLog('All Codex accounts at capacity. No switch possible.', { persist: true });
    return { switched: false };
  }

  if (forced && !isRateLimited) {
    sendNotification('OAuth Switch', 'Codex usage high, but no viable target. Staying put.');
    autoLog('Codex usage high, but no viable target. Staying put.', { persist: true });
    return { switched: false };
  }

  backupFile(AUTH_PATH);
  if (typeof target.index === 'number' && store.accounts[target.index]) {
    store.accounts[target.index].lastUsedAt = new Date().toISOString();
  }
  store.updatedAt = new Date().toISOString();
  writeJson(STORE_PATH, store);
  writeJson(AUTH_PATH, target.auth);
  state.recordAutoSwitch('codex', currentKey, target.key);

  sendNotification('OAuth Switch', `Codex switched to ${target.displayName}. Restart to apply.`);
  autoLog(`Switched Codex to ${target.displayName}.`, { persist: true });
  return { switched: true };
}

function shouldTriggerCodex(usage) {
  if (!usage) return false;
  // Endpoint throttling is never an account signal (see shouldTrigger).
  if (usage.api_throttled) return false;
  if (usage.rate_limited) return true;
  const fiveH = usage.five_hour_percent;
  const weekly = usage.weekly_percent;
  if (typeof fiveH === 'number' && fiveH >= THRESHOLDS.trigger5h) return true;
  if (typeof weekly === 'number' && weekly >= THRESHOLDS.trigger7d) return true;
  return false;
}

function fetchCodexUsage(accessToken) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'oauth-switch/1.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Endpoint throttling of our polling, not an account limit.
          const retrySecs = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          resolve({ api_throttled: true, retry_after: Number.isNaN(retrySecs) ? null : retrySecs });
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Codex usage API returned ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const primaryWindow = parsed.rate_limit?.primary_window;
          const secondaryWindow = parsed.rate_limit?.secondary_window;
          resolve({
            rate_limited: parsed.rate_limited === true || parsed.rate_limit?.limit_reached === true,
            five_hour_percent: parsed.five_hour_percent ?? parsed.five_hour?.utilization ?? primaryWindow?.used_percent,
            five_hour_reset: parsed.five_hour_reset ?? parsed.five_hour?.resets_at ?? (typeof primaryWindow?.reset_at === 'number' ? new Date(primaryWindow.reset_at * 1000).toISOString() : null),
            weekly_percent: parsed.weekly_percent ?? parsed.seven_day?.utilization ?? parsed.weekly?.utilization ?? secondaryWindow?.used_percent,
            weekly_reset: parsed.weekly_reset ?? parsed.seven_day?.resets_at ?? (typeof secondaryWindow?.reset_at === 'number' ? new Date(secondaryWindow.reset_at * 1000).toISOString() : null),
            raw: parsed,
          });
        } catch {
          reject(new Error(`Failed to parse Codex usage: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Codex usage API timeout'));
    });
  });
}

module.exports = {
  runAutoSwitchClaude,
  runAutoSwitchCodex,
  THRESHOLDS,
  SNAPSHOT_FRESHNESS_MS,
  NONCURRENT_REFRESH_MS,
  AUTO_SWITCH_COOLDOWN_MS,
  SWITCHED_FROM_EXCLUDE_MS,
  getAutoSwitchCooldown,
  notify,
  shouldTrigger,
  isSnapshotFresh,
  isTargetViable,
  pickBestTarget,
  pickBestCodexTarget,
  toCodexUsageSnapshot,
  refreshCodexUsageSnapshots,
  fetchCodexUsage,
};
