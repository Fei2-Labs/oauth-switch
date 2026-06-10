const {
  getClaudeAccountGroups,
} = require('../store/accounts.cjs');

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

function isAuthFailure(err) {
  return err?.statusCode === 401 || err?.statusCode === 403;
}

// Non-current account groups are only refetched when their snapshot is
// missing or older than this. The current group is refreshed every cycle.
// Compatible with the 2h viability freshness gate in auto-switch.
const NONCURRENT_REFRESH_MS = 30 * 60 * 1000;

function isSnapshotFresherThan(snapshot, maxAgeMs, now = Date.now()) {
  if (!snapshot || !snapshot.fetchedAt) return false;
  const fetched = new Date(snapshot.fetchedAt).getTime();
  if (Number.isNaN(fetched)) return false;
  return now - fetched <= maxAgeMs;
}

async function refreshStoredUsageSnapshots(store, currentKey, fetchUsage, options = {}) {
  const refreshOAuthToken = options.refreshOAuthToken || require('./fetch.cjs').refreshOAuthToken;
  const now = options.now ?? Date.now();
  let currentUsage = null;
  let changed = false;
  // null, or { retryAfter } when the usage endpoint throttled this machine.
  let apiThrottled = null;

  // Current account group first: it must be refreshed every cycle, and a
  // throttle response aborts all remaining fetches in this loop.
  const groups = getClaudeAccountGroups(store);
  const hasCurrent = (group) => group.entries.some(({ entry }) => entry.key === currentKey);
  const orderedGroups = [...groups.filter(hasCurrent), ...groups.filter((g) => !hasCurrent(g))];

  for (const group of orderedGroups) {
    const representative = group.entries.find(({ entry }) => entry?.credentials?.claudeAiOauth?.accessToken)?.entry
      || group.entries[0]?.entry;
    const accessToken = representative?.credentials?.claudeAiOauth?.accessToken;
    if (!accessToken) continue;
    const groupHasCurrent = hasCurrent(group);
    if (!groupHasCurrent) {
      // Fully disabled groups can never be switch targets: don't spend
      // usage-API requests on them.
      if (group.entries.every(({ entry }) => entry.disabled)) continue;
      // Recent-enough snapshot: skip the refetch to cut polling volume.
      if (isSnapshotFresherThan(representative.usageSnapshot, NONCURRENT_REFRESH_MS, now)) continue;
    }
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
        const refreshed = await refreshOAuthToken(refreshTokenValue);
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
      if (groupHasCurrent) {
        currentUsage = usage;
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
      // Keep previous snapshot on failure (token may be revoked).
    }
  }
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
  const fiveHourPct = formatUsagePercent(usage.five_hour?.utilization);
  const fiveHourReset = formatDurationUntil(usage.five_hour?.resets_at);
  const sevenDayPct = formatUsagePercent(usage.seven_day?.utilization);
  const sevenDayReset = formatDurationUntil(rateLimitReset || usage.seven_day?.resets_at) || formatResetEstimate(entry.lastSyncedAt, entry.current ? entry.key : null, getRateLimitResetAt, resetWindowDays);
  return `5H:${fiveHourPct}(${fiveHourReset}) | 7D:${sevenDayPct} (${sevenDayReset})`;
}

module.exports = {
  formatUsageInfo,
  toUsageSnapshot,
  refreshStoredUsageSnapshots,
  NONCURRENT_REFRESH_MS,
  isSnapshotFresherThan,
  formatUsagePercent,
  formatDurationUntil,
  formatResetEstimate,
  getUsageColumns,
};
