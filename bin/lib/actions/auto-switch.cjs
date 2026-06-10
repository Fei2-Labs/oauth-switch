const { execSync } = require('child_process');
const path = require('path');

const THRESHOLDS = {
  trigger5h: 80,
  trigger7d: 90,
  target5h: 60,
  target7d: 80,
};

const { getDisplayAccounts } = require('../store/accounts.cjs');

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

function isTargetViable(usageSnapshot) {
  if (!usageSnapshot) return false;
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
  } = context;

  const currentKey = getAccountKey(config.oauthAccount);
  const accounts = getDisplayAccounts(store, config.oauthAccount, credentials);
  const accessToken = credentials?.claudeAiOauth?.accessToken;

  if (!accessToken) {
    console.log('[auto] No access token for current Claude account.');
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
    console.log(`[auto] Failed to fetch usage: ${err.message}`);
    return { switched: false };
  }

  if (!shouldTrigger(currentUsage)) {
    console.log('[auto] Claude Code usage within limits. No switch needed.');
    return { switched: false };
  }

  const isRateLimited = currentUsage?.rate_limited === true;
  const { target, forced } = pickBestTarget(accounts, currentKey);

  if (!target) {
    notify('OAuth Switch', 'All Claude accounts at capacity. No switch possible.');
    console.log('[auto] All accounts at capacity.');
    return { switched: false };
  }

  if (forced && !isRateLimited) {
    notify('OAuth Switch', 'Claude usage high, but no viable target. Staying put.');
    console.log('[auto] No viable target. Only notifying.');
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
  notify('OAuth Switch', `Claude switched to ${name} (${reason}). Restart to apply.`);
  console.log(`[auto] Switched Claude to ${name} (${reason}).`);
  return { switched: true };
}

async function runAutoSwitchCodex(context) {
  const { readJson, writeJson, backupFile, AUTH_PATH, STORE_PATH, decodeJwtPayload } = context;
  const { getCodexAccountKey, getDisplayCodexAccounts } = require('../providers/codex-identity.cjs');

  const auth = readJson(AUTH_PATH);
  if (!auth || !auth.tokens?.access_token) {
    console.log('[auto] No Codex OAuth session found.');
    return { switched: false };
  }

  const store = readJson(STORE_PATH) || { version: '1.0.0', accounts: [] };
  if (store.accounts.length < 2) {
    console.log('[auto] Only one Codex account stored. Nothing to switch to.');
    return { switched: false };
  }

  let currentUsage;
  try {
    currentUsage = await fetchCodexUsage(auth.tokens.access_token);
  } catch (err) {
    console.log(`[auto] Failed to fetch Codex usage: ${err.message}`);
    return { switched: false };
  }

  if (!shouldTriggerCodex(currentUsage)) {
    console.log('[auto] Codex usage within limits. No switch needed.');
    return { switched: false };
  }

  const currentKey = getCodexAccountKey(auth);
  const accounts = getDisplayCodexAccounts(store, auth);

  const candidates = accounts
    .filter((a) => !a.current && a.key !== currentKey && !a.disabled)
    .sort((a, b) => {
      const aScore = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const bScore = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return aScore - bScore;
    });

  if (candidates.length === 0) {
    notify('OAuth Switch', 'All Codex accounts at capacity.');
    console.log('[auto] No Codex targets available.');
    return { switched: false };
  }

  const target = candidates[0];
  backupFile(AUTH_PATH);
  if (typeof target.index === 'number' && store.accounts[target.index]) {
    store.accounts[target.index].lastUsedAt = new Date().toISOString();
  }
  store.updatedAt = new Date().toISOString();
  writeJson(STORE_PATH, store);
  writeJson(AUTH_PATH, target.auth);

  notify('OAuth Switch', `Codex switched to ${target.displayName}. Restart to apply.`);
  console.log(`[auto] Switched Codex to ${target.displayName}.`);
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
  notify,
  shouldTrigger,
  pickBestTarget,
  fetchCodexUsage,
};
