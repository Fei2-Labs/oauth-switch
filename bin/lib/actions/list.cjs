const state = require('../store/state.cjs');

async function runListAction(context) {
  const {
    synced,
    store,
    config,
    credentials,
    options,
    writeStore,
    getAccountKey,
    refreshStoredUsageSnapshots,
    fetchUsage,
    formatUsageInfo,
    formatAccountSummary,
    getDisplayAccounts,
    getListGuidance,
    getAvailableAccountsHeading,
    getRateLimitResetAt,
    setRateLimitResetAt,
    setRateLimitResetAtFromIso,
    ensureDir,
  } = context;

  if (synced.changed) {
    writeStore(store, options);
    console.log(`Saved the current account snapshot into ${context.path.basename(options.storePath)} before showing the account list.`);
  }

  const accessToken = credentials?.claudeAiOauth?.accessToken;
  // Endpoint-throttle gate (same as the `usage` action): while the 429
  // backoff deadline is active, make ZERO usage requests; the account rows
  // below render the stored snapshots. --force bypasses the gate.
  const throttledUntil = options.force ? null : state.getProviderThrottleUntil('claude');
  if (accessToken && throttledUntil) {
    console.log(`Usage API throttled, showing cached data, next attempt at ${new Date(throttledUntil).toLocaleTimeString()}.`);
    console.log('');
  } else if (accessToken) {
    try {
      const { currentUsage, changed, apiThrottled } = await refreshStoredUsageSnapshots(
        store,
        getAccountKey(config.oauthAccount),
        (token) => fetchUsage(token, {
          setRateLimitResetAt: (secs) => setRateLimitResetAt(secs, ensureDir),
          setRateLimitResetAtFromIso: (iso) => setRateLimitResetAtFromIso(iso, ensureDir),
        })
      );
      if (changed) {
        writeStore(store, options);
      }
      if (apiThrottled) {
        // Record the new backoff deadline (exponential on consecutive 429s).
        state.setProviderThrottle('claude', apiThrottled.retryAfter);
      } else if (currentUsage) {
        // Successful fetch: end any throttle episode and reset the streak.
        state.resetProviderThrottle('claude');
      }
      if (options.showUsage && currentUsage) {
        console.log('--- Usage ---');
        for (const line of formatUsageInfo(currentUsage)) console.log(line);
        console.log('');
      }
    } catch {
      // Ignore usage refresh failures and render cached values.
    }
  }

  console.log(getAvailableAccountsHeading());
  for (const line of formatAccountSummary(getDisplayAccounts(store, config.oauthAccount, credentials))) {
    console.log(line);
  }
  console.log('');
  for (const line of getListGuidance(options.usageCommand)) console.log(line);
}

module.exports = { runListAction };
