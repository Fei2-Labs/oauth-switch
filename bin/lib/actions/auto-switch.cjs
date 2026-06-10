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

function pickBestTarget(accounts, currentKey) {
  const candidates = accounts
    .filter((a) => !a.current && a.key !== currentKey && a.usageSnapshot && !a.disabled)
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
  const fiveH = snapshot?.five_hour?.utilization ?? 100;
  const sevenD = snapshot?.seven_day?.utilization ?? 100;
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
function pickBestCodexTarget(accounts, currentKey) {
  const candidates = accounts.filter((a) => !a.current && a.key !== currentKey && !a.disabled);

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

// Refresh usage snapshots for ALL stored Codex accounts, deduped by
// credential fingerprint so the same token is not fetched twice for org
// variants. Per-account fetch failures keep the old snapshot and never
// abort the run. Returns true when any snapshot changed.
async function refreshCodexUsageSnapshots(store, currentAuth, currentUsage, fetchUsageFn = fetchCodexUsage) {
  const { getCodexCredentialFingerprint } = require('../providers/codex-identity.cjs');
  const usageByFingerprint = new Map();
  const currentFingerprint = currentAuth ? getCodexCredentialFingerprint(currentAuth) : null;
  if (currentFingerprint && currentUsage) {
    usageByFingerprint.set(currentFingerprint, currentUsage);
  }

  let changed = false;
  const now = new Date().toISOString();
  for (const [index, entry] of (store.accounts || []).entries()) {
    const accessToken = entry?.auth?.tokens?.access_token;
    if (!accessToken) continue;
    const fingerprint = getCodexCredentialFingerprint(entry.auth) || `entry:${entry.key}`;
    if (!usageByFingerprint.has(fingerprint)) {
      try {
        usageByFingerprint.set(fingerprint, await fetchUsageFn(accessToken));
      } catch {
        // Keep the old snapshot for this credential; continue with the rest.
        usageByFingerprint.set(fingerprint, null);
      }
    }
    const usage = usageByFingerprint.get(fingerprint);
    if (!usage) continue;
    const snapshot = toCodexUsageSnapshot(usage, now);
    if (!snapshot.five_hour && !snapshot.seven_day) continue;
    const before = JSON.stringify(store.accounts[index].usageSnapshot || null);
    if (before !== JSON.stringify(snapshot)) {
      store.accounts[index].usageSnapshot = snapshot;
      changed = true;
    }
  }
  return changed;
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

  let currentUsage;
  try {
    const { currentUsage: usage, changed } = await refreshStoredUsageSnapshots(
      store,
      currentKey,
      (token) => fetchUsage(token, {
        setRateLimitResetAt: (secs) => setRateLimitResetAt(secs, ensureDir),
        setRateLimitResetAtFromIso: (iso) => setRateLimitResetAtFromIso(iso, ensureDir),
      })
    );
    if (changed) writeStore(store, options);
    currentUsage = usage;
  } catch (err) {
    autoLog(`Failed to fetch usage: ${err.message}`);
    return { switched: false };
  }

  if (!shouldTrigger(currentUsage)) {
    autoLog('Claude Code usage within limits. No switch needed.');
    return { switched: false };
  }

  // Compute display accounts AFTER the snapshot refresh: the refresh replaces
  // usageSnapshot objects on the store entries, so a pre-refresh shallow copy
  // would still hold the stale snapshots and pickBestTarget would run blind.
  const accounts = getDisplayAccounts(store, config.oauthAccount, credentials);
  const isRateLimited = currentUsage?.rate_limited === true;
  const { target, forced } = pickBestTarget(accounts, currentKey);

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

  const name = target.metadata?.emailAddress || target.key;
  const reason = isRateLimited ? 'rate limited (429)' : 'usage threshold exceeded';
  sendNotification('OAuth Switch', `Claude switched to ${name} (${reason}). Restart to apply.`);
  autoLog(`Switched Claude to ${name} (${reason}).`, { persist: true });
  return { switched: true };
}

async function runAutoSwitchCodex(context) {
  const { readJson, writeJson, backupFile, AUTH_PATH, STORE_PATH, decodeJwtPayload } = context;
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

  let currentUsage;
  try {
    currentUsage = await fetchCodexUsage(auth.tokens.access_token);
  } catch (err) {
    autoLog(`Failed to fetch Codex usage: ${err.message}`);
    return { switched: false };
  }

  if (!shouldTriggerCodex(currentUsage)) {
    autoLog('Codex usage within limits. No switch needed.');
    return { switched: false };
  }

  const currentKey = getCodexAccountKey(auth);

  // Refresh ALL stored accounts' usage before picking, so target selection
  // never runs on blind/stale data.
  const snapshotsChanged = await refreshCodexUsageSnapshots(store, auth, currentUsage);
  if (snapshotsChanged) {
    store.updatedAt = new Date().toISOString();
    writeJson(STORE_PATH, store);
  }

  const accounts = getDisplayCodexAccounts(store, auth);
  const isRateLimited = currentUsage?.rate_limited === true;
  const { target, forced } = pickBestCodexTarget(accounts, currentKey);

  if (!target) {
    notify('OAuth Switch', 'All Codex accounts at capacity.');
    autoLog('All Codex accounts at capacity. No switch possible.', { persist: true });
    return { switched: false };
  }

  if (forced && !isRateLimited) {
    notify('OAuth Switch', 'Codex usage high, but no viable target. Staying put.');
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

  notify('OAuth Switch', `Codex switched to ${target.displayName}. Restart to apply.`);
  autoLog(`Switched Codex to ${target.displayName}.`, { persist: true });
  return { switched: true };
}

function shouldTriggerCodex(usage) {
  if (!usage) return false;
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
          resolve({ rate_limited: true });
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
