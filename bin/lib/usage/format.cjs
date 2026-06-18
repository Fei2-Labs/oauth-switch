const {
  getClaudeAccountGroups,
  setGroupCredentialStatus,
  clearGroupCredentialStatus,
} = require('../store/accounts.cjs');
const {
  getLastNonCurrentFetchAt,
  setLastNonCurrentFetchAt,
} = require('../store/state.cjs');

function formatUsageInfo(usage) {
  const lines = [];
  if (usage.api_throttled) {
    // Endpoint throttling of this machine's polling, not an account limit.
    const retrySecs = usage.retry_after ? parseInt(usage.retry_after, 10) : null;
    if (retrySecs) {
      lines.push(`Usage API is throttling this machine (HTTP 429). Not an account limit. Retry in ~${retrySecs}s.`);
    } else {
      lines.push('Usage API is throttling this machine (HTTP 429). Not an account limit. Try again later.');
    }
    return lines;
  }
  if (usage.rate_limited) {
    const retrySecs = usage.retry_after ? parseInt(usage.retry_after, 10) : null;
    if (retrySecs) {
      const resetAt = new Date(Date.now() + retrySecs * 1000);
      const h = Math.floor(retrySecs / 3600);
      const m = Math.floor((retrySecs % 3600) / 60);
      const s = retrySecs % 60;
      let countdown = '';
      if (h > 0) countdown = `~${h}h ${m}m`;
      else if (m > 0) countdown = `~${m}m ${s}s`;
      else countdown = `~${s}s`;
      lines.push(`Usage API is rate limited. Resets in ${countdown} (at ${resetAt.toLocaleTimeString()}).`);
    } else {
      lines.push('Usage API is rate limited. Try again in a few seconds.');
    }
    return lines;
  }
  if (usage.five_hour) {
    const pct = typeof usage.five_hour.utilization === 'number' ? (100 - usage.five_hour.utilization).toFixed(1) : 'N/A';
    const resetsAt = usage.five_hour.resets_at ? new Date(usage.five_hour.resets_at).toLocaleString() : 'unknown';
    lines.push(`5h remaining/reset: ${pct}% / ${resetsAt}`);
  }
  if (usage.seven_day) {
    const pct = typeof usage.seven_day.utilization === 'number' ? (100 - usage.seven_day.utilization).toFixed(1) : 'N/A';
    const resetsAt = usage.seven_day.resets_at ? new Date(usage.seven_day.resets_at).toLocaleString() : 'unknown';
    lines.push(`7d remaining/reset: ${pct}% / ${resetsAt}`);
  }
  if (lines.length === 0) {
    lines.push('No usage data available for this account.');
  }
  return lines;
}

function toUsageSnapshot(usage) {
  if (!usage || usage.rate_limited || usage.api_throttled) return null;
  const hasFiveHour = usage.five_hour && (typeof usage.five_hour.utilization === 'number' || usage.five_hour.resets_at);
  const hasSevenDay = usage.seven_day && (typeof usage.seven_day.utilization === 'number' || usage.seven_day.resets_at);
  if (!hasFiveHour && !hasSevenDay) return null;
  return {
    five_hour: usage.five_hour ? {
      utilization: usage.five_hour.utilization,
      resets_at: usage.five_hour.resets_at,
    } : undefined,
    seven_day: usage.seven_day ? {
      utilization: usage.seven_day.utilization,
      resets_at: usage.seven_day.resets_at,
    } : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

function shouldKeepExistingSnapshot(existingSnapshot, nextSnapshot, isCurrentAccount) {
  if (isCurrentAccount || !existingSnapshot || !nextSnapshot) {
    return false;
  }

  const fiveHourUtil = nextSnapshot.five_hour?.utilization;
  const fiveHourReset = nextSnapshot.five_hour?.resets_at ? new Date(nextSnapshot.five_hour.resets_at).getTime() : null;
  const now = Date.now();

  // Heuristic for seatless/non-usable accounts:
  // API often reports 100% used with an immediate reset while the previously cached
  // snapshot still has a sensible value. In that case, keep the known-good snapshot.
  if (fiveHourUtil === 100 && fiveHourReset && fiveHourReset <= now + 60 * 1000) {
    return true;
  }

  return false;
}

// A snapshot whose fetchedAt is older than this (or missing) is "stale": the
// daemon may be backed off from a usage-API 429, so the stored numbers could
// be hours old. Mirrors the app's STALE_THRESHOLD (20 minutes).
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

// True when the snapshot is fresh enough to trust its reset-aware reasoning.
// A missing/unparseable fetchedAt counts as stale.
function isSnapshotFresh(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return false;
  const ms = new Date(fetchedAt).getTime();
  if (Number.isNaN(ms)) return false;
  return now - ms <= STALE_THRESHOLD_MS;
}

// A usage window whose resets_at is already in the past HAS reset since the
// snapshot was taken: its stored utilization is obsolete.
function isWindowReset(window, now = Date.now()) {
  if (!window || !window.resets_at) return false;
  const resetAt = new Date(window.resets_at).getTime();
  return !Number.isNaN(resetAt) && resetAt <= now;
}

// Reset-aware utilization with a freshness guard.
//
// The reset->0 rule is only honest IMMEDIATELY after a reset. For a STALE
// snapshot the real usage is UNKNOWN: the window reset AND may have been
// refilled to 100%, so fabricating 0% hides a maxed account. Therefore the
// reset->0 zeroing is applied ONLY when the snapshot is fresh; a stale snapshot
// returns the RAW last-known utilization unchanged (the caller already flags it
// stale with a "?"/age marker).
//
// `fetchedAt` is the parent snapshot's fetch timestamp. When omitted the
// snapshot is treated as stale (no zeroing).
function effectiveWindowUtilization(window, fetchedAt, now = Date.now()) {
  if (!window) return undefined;
  if (isSnapshotFresh(fetchedAt, now) && isWindowReset(window, now)) return 0;
  return window.utilization;
}

function isAuthFailure(err) {
  return err?.statusCode === 401 || err?.statusCode === 403;
}

// Token-endpoint statuses that mean the refresh token is permanently dead and
// the group needs a manual re-login. 5xx/network/timeout/429 stay transient.
const REAUTH_STATUS_CODES = new Set([400, 401, 403, 404]);

// Non-current account groups are only refetched when their snapshot is
// missing or older than this. The current group is refreshed every cycle.
// Compatible with the 2h viability freshness gate in auto-switch.
const NONCURRENT_REFRESH_MS = 30 * 60 * 1000;

// Approach gate: non-current account groups are ONLY polled when the CURRENT
// account is nearing its switch trigger (5h>=80 or 7d>=90). While the current
// account has headroom there is no reason to poll targets, so steady-state
// volume drops to ~1 usage request per cycle (just the current account). These
// thresholds sit ~20 points BELOW the triggers (matching the existing
// target5h/target7d viability bar) so target snapshots start warming a few
// cycles before a switch becomes likely — by the time the current account
// crosses the trigger, viable targets already have fresh (<2h) snapshots.
const APPROACH_5H = 60; // == THRESHOLDS.target5h
const APPROACH_7D = 70; // just below trigger7d (90), within the warm-up band

// Even within the approach band, the daemon warms non-current target snapshots
// at MOST once per this interval. A chronically-approaching active account
// (e.g. 7d ~74-81% for hours) would otherwise poll a non-current group EVERY
// 5-min cycle, keeping request volume high and tripping the usage-endpoint rate
// limit. The current account is still fetched every cycle (trigger detection).
// EXCEPTION: when the current account is genuinely rate_limited (429 on the
// active account => switch NOW), this interval is bypassed so targets refresh
// immediately for the imminent switch.
const NON_CURRENT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// True when the current account's just-fetched usage means we should warm
// non-current target snapshots this cycle: it is rate_limited, or either
// window is within the approach band of its trigger.
function isApproachingTrigger(usage) {
  if (!usage || usage.api_throttled) return false;
  if (usage.rate_limited) return true;
  const fiveH = usage.five_hour?.utilization;
  const sevenD = usage.seven_day?.utilization;
  if (typeof fiveH === 'number' && fiveH >= APPROACH_5H) return true;
  if (typeof sevenD === 'number' && sevenD >= APPROACH_7D) return true;
  return false;
}

function isSnapshotFresherThan(snapshot, maxAgeMs, now = Date.now()) {
  if (!snapshot || !snapshot.fetchedAt) return false;
  const fetched = new Date(snapshot.fetchedAt).getTime();
  if (Number.isNaN(fetched)) return false;
  return now - fetched <= maxAgeMs;
}

function pickGroupRepresentative(group) {
  return group.entries.find(({ entry }) => entry?.credentials?.claudeAiOauth?.accessToken)?.entry
    || group.entries[0]?.entry;
}

function snapshotFetchedAtMs(snapshot) {
  if (!snapshot || !snapshot.fetchedAt) return 0;
  const ms = new Date(snapshot.fetchedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

async function refreshStoredUsageSnapshots(store, currentKey, fetchUsage, options = {}) {
  const refreshOAuthToken = options.refreshOAuthToken || require('./fetch.cjs').refreshOAuthToken;
  const now = options.now ?? Date.now();
  const provider = options.provider || 'claude';
  // Test/sandbox hooks default to the real state helpers; overridable so tests
  // can inject the interval timestamp without writing the on-disk state.json.
  const getLastNonCurrent = options.getLastNonCurrentFetchAt || getLastNonCurrentFetchAt;
  const setLastNonCurrent = options.setLastNonCurrentFetchAt || setLastNonCurrentFetchAt;
  let currentUsage = null;
  let changed = false;
  // null, or { retryAfter } when the usage endpoint throttled this machine.
  let apiThrottled = null;

  // Current account group first: it must be refreshed every cycle, and a
  // throttle response aborts all remaining fetches in this loop.
  const groups = getClaudeAccountGroups(store);
  const hasCurrent = (group) => group.entries.some(({ entry }) => entry.key === currentKey);
  // Request budget: at most ONE non-current group is fetched per cycle — the
  // eligible one with the OLDEST snapshot (missing snapshot counts as oldest).
  // The rest wait for future cycles, which yields a natural round-robin.
  // Fully disabled groups can never be switch targets and fresh-enough
  // snapshots are never refetched, so neither consumes the single slot.
  const eligibleNonCurrent = groups
    .filter((g) => !hasCurrent(g))
    .filter((group) => {
      const representative = pickGroupRepresentative(group);
      if (!representative?.credentials?.claudeAiOauth?.accessToken) return false;
      if (group.entries.every(({ entry }) => entry.disabled)) return false;
      return !isSnapshotFresherThan(representative.usageSnapshot, NONCURRENT_REFRESH_MS, now);
    })
    .sort((a, b) => snapshotFetchedAtMs(pickGroupRepresentative(a)?.usageSnapshot)
      - snapshotFetchedAtMs(pickGroupRepresentative(b)?.usageSnapshot));

  // Approach-gated polling: the current group is always processed first, then
  // its result decides whether to spend the single non-current slot this cycle.
  // While the current account is below the approach band the round-robin is
  // skipped entirely, so steady-state volume is ~1 request/cycle.
  const currentGroups = groups.filter(hasCurrent);
  const orderedGroups = [...currentGroups];
  const currentGroupCount = currentGroups.length;
  let nonCurrentAppended = false;
  // null until the current group decision is made: true => warm targets this
  // cycle, false => skip them (current account has headroom).
  let approachAllowsNonCurrent = currentGroupCount === 0 ? true : null;
  // True when the current account is genuinely rate_limited (429) and must
  // switch NOW. In that case the 15-min non-current interval is BYPASSED so
  // targets refresh immediately for the imminent switch.
  let currentRateLimited = false;

  // Per-provider 15-min throttle on non-current warming: even within the
  // approach band, a chronically-approaching active account would otherwise
  // poll a non-current group every cycle. Bypassed when the current account is
  // genuinely rate_limited (handled at the append site).
  const lastNonCurrentFetchAt = getLastNonCurrent(provider);
  const intervalElapsed = now - lastNonCurrentFetchAt >= NON_CURRENT_MIN_INTERVAL_MS;

  // Append the single non-current slot exactly once, after the current
  // group(s) settle the approach decision. When the store has no current
  // group (e.g. the active account isn't pooled) we always allow it so
  // keep-alive reauth detection and stale-snapshot refresh still run.
  // `bypassInterval` skips the 15-min throttle: set for the rate_limited
  // active-switch case and for the no-current-group keep-alive path (which must
  // keep running every cycle for reauth detection / stale-snapshot refresh).
  const maybeAppendNonCurrent = (bypassInterval = false) => {
    if (nonCurrentAppended || approachAllowsNonCurrent !== true) return;
    // Rate-limit the non-current warm to once per 15 min while merely
    // approaching; bypass it only when the current account is rate_limited.
    if (!intervalElapsed && !bypassInterval && !currentRateLimited) return;
    nonCurrentAppended = true;
    orderedGroups.push(...eligibleNonCurrent.slice(0, 1));
  };

  // When the store has no current group at all, the approach decision is moot:
  // append the non-current slot up front so keep-alive/stale refresh still run.
  // This keep-alive path is exempt from the 15-min interval.
  if (currentGroupCount === 0) maybeAppendNonCurrent(true);

  // Set when a non-current group is actually fetched this cycle; persists the
  // interval timestamp once after the loop so the next ~15 min skip the warm.
  let nonCurrentFetched = false;
  for (let i = 0; i < orderedGroups.length; i += 1) {
    const group = orderedGroups[i];
    const representative = pickGroupRepresentative(group);
    const accessToken = representative?.credentials?.claudeAiOauth?.accessToken;
    if (!accessToken) continue;
    const groupHasCurrent = hasCurrent(group);
    if (!groupHasCurrent) nonCurrentFetched = true;
    try {
      let usage;
      try {
        usage = await fetchUsage(accessToken);
      } catch (err) {
        // Expired/invalid token: try an OAuth refresh and retry the fetch once.
        // Only the STORE copies of the credentials are updated here — never
        // the live ~/.claude credentials/Keychain.
        const refreshTokenValue = representative?.credentials?.claudeAiOauth?.refreshToken;
        if (!isAuthFailure(err) || !refreshTokenValue) throw err;
        let refreshed;
        try {
          refreshed = await refreshOAuthToken(refreshTokenValue);
        } catch (refreshErr) {
          // A 4xx from the OAuth token endpoint means the refreshToken is
          // revoked: the whole credential group needs a manual re-login.
          // Network errors/timeouts are transient and must NOT mark.
          // Only 400/401/403/404 = dead refresh token. 5xx, network errors,
          // timeouts and 429 are transient and must NOT mark reauth_required.
          // Safety guard: NEVER mark the currently-active account as
          // reauth_required. Its authoritative credentials live in the
          // Keychain/live config and are refreshed from live via
          // syncStoreFromLive every cycle, so a stale pool-copy 401 here is not
          // evidence the account is dead — the next sync from live will heal it.
          if (REAUTH_STATUS_CODES.has(refreshErr?.statusCode) && !groupHasCurrent) {
            if (setGroupCredentialStatus(store, group, 'reauth_required', new Date(now).toISOString())) {
              changed = true;
            }
          }
          throw refreshErr;
        }
        for (const { index } of group.entries) {
          const oauth = store.accounts[index]?.credentials?.claudeAiOauth;
          if (!oauth) continue;
          oauth.accessToken = refreshed.accessToken;
          if (refreshed.refreshToken) oauth.refreshToken = refreshed.refreshToken;
          if (refreshed.expiresAt) oauth.expiresAt = refreshed.expiresAt;
          changed = true;
        }
        usage = await fetchUsage(refreshed.accessToken);
      }
      // The token works (fetch or refresh succeeded): clear any stale
      // reauth marker on this credential group. A 429 proves nothing about
      // the token, so a throttled response never clears.
      if (!usage?.api_throttled && clearGroupCredentialStatus(store, group)) {
        changed = true;
      }
      if (groupHasCurrent) {
        currentUsage = usage;
        // Approach gate: warm non-current target snapshots this cycle only when
        // the current account is nearing its trigger (or rate-limited). With
        // headroom, skip the round-robin entirely (~1 request/cycle steady
        // state). An api_throttled current response leaves the decision to the
        // abort path below (skip the rest, as today).
        if (approachAllowsNonCurrent === null && !usage?.api_throttled) {
          currentRateLimited = usage?.rate_limited === true;
          approachAllowsNonCurrent = isApproachingTrigger(usage);
          maybeAppendNonCurrent();
        }
      }
      if (usage?.api_throttled) {
        // Endpoint throttling of this machine: abort all remaining fetches
        // immediately and keep the old snapshots.
        apiThrottled = { retryAfter: usage.retry_after ?? null };
        break;
      }
      const nextSnapshot = toUsageSnapshot(usage);
      if (!nextSnapshot) continue;
      if (shouldKeepExistingSnapshot(representative.usageSnapshot, nextSnapshot, groupHasCurrent)) {
        continue;
      }

      for (const { index } of group.entries) {
        const before = JSON.stringify(store.accounts[index].usageSnapshot || null);
        const after = JSON.stringify(nextSnapshot);
        if (before !== after) {
          store.accounts[index].usageSnapshot = nextSnapshot;
          changed = true;
        }
      }
    } catch {
      // Keep previous snapshot on failure (token may be revoked). If the
      // CURRENT group failed we couldn't read its usage to assess approach;
      // fall back to allowing the non-current slot so keep-alive reauth
      // detection and stale-snapshot refresh still run for the pool.
      if (groupHasCurrent && approachAllowsNonCurrent === null) {
        approachAllowsNonCurrent = true;
        // Current usage was unreadable: this is the keep-alive/stale-refresh
        // fallback, not the chronically-approaching steady state, so it is
        // exempt from the 15-min interval.
        maybeAppendNonCurrent(true);
      }
    }
  }
  // Record the interval only when a non-current group was actually fetched so
  // the next ~15 min skip the warm (unless the current account is rate_limited).
  if (nonCurrentFetched) setLastNonCurrent(provider, now);
  return { currentUsage, changed, apiThrottled };
}

function formatUsagePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '?';
  return `${Math.round(value)}%`;
}

function formatDurationUntil(dateLike) {
  if (!dateLike) return 'unknown';
  const resetAt = new Date(dateLike).getTime();
  if (Number.isNaN(resetAt)) return 'unknown';
  const diff = resetAt - Date.now();
  if (diff <= 0) return 'now';
  const totalHours = Math.floor(diff / 3600000);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}D ${hours}h`;
  }
  const minutes = Math.floor((diff % 3600000) / 60000);
  return `~${totalHours}h ${minutes}min`;
}

function formatResetEstimate(isoString, accountKey, getRateLimitResetAt, resetWindowDays) {
  const rateLimitReset = getRateLimitResetAt();
  if (rateLimitReset && accountKey) {
    const diff = rateLimitReset - Date.now();
    if (diff > 0) {
      const hours = Math.floor(diff / 3600000);
      if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `~${days}d ${remainingHours}h`;
      }
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      if (hours > 0) return `~${hours}h ${minutes}m`;
      if (minutes > 0) return `~${minutes}m ${seconds}s`;
      return `~${seconds}s`;
    }
  }
  if (!isoString) return 'unknown';
  const resetDate = new Date(new Date(isoString).getTime() + resetWindowDays * 86400000);
  const diff = resetDate.getTime() - Date.now();
  if (diff <= 0) return 'reset now';
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `~${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `~${days}d ${remainingHours}h`;
}

function getUsageColumns(entry, getRateLimitResetAt, resetWindowDays) {
  const usage = entry.usageSnapshot || {};
  const rateLimitReset = entry.current ? getRateLimitResetAt() : null;
  // Windows whose resets_at already passed have reset since the snapshot was
  // taken: render them as 0% used (formatDurationUntil shows "now").
  const fiveHourPct = formatUsagePercent(effectiveWindowUtilization(usage.five_hour, usage.fetchedAt));
  const fiveHourReset = formatDurationUntil(usage.five_hour?.resets_at);
  const sevenDayPct = formatUsagePercent(effectiveWindowUtilization(usage.seven_day, usage.fetchedAt));
  const sevenDayReset = formatDurationUntil(rateLimitReset || usage.seven_day?.resets_at) || formatResetEstimate(entry.lastSyncedAt, entry.current ? entry.key : null, getRateLimitResetAt, resetWindowDays);
  return `5H:${fiveHourPct}(${fiveHourReset}) | 7D:${sevenDayPct} (${sevenDayReset})`;
}

module.exports = {
  formatUsageInfo,
  toUsageSnapshot,
  refreshStoredUsageSnapshots,
  NONCURRENT_REFRESH_MS,
  NON_CURRENT_MIN_INTERVAL_MS,
  APPROACH_5H,
  APPROACH_7D,
  isApproachingTrigger,
  isSnapshotFresherThan,
  isWindowReset,
  effectiveWindowUtilization,
  STALE_THRESHOLD_MS,
  formatUsagePercent,
  formatDurationUntil,
  formatResetEstimate,
  getUsageColumns,
};
