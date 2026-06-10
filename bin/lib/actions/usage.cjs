const state = require('../store/state.cjs');

async function runUsageAction(context) {
  const { store, config, fetchUsage, formatUsageInfo, setRateLimitResetAt, setRateLimitResetAtFromIso, ensureDir, refreshStoredUsageSnapshots, writeStore, options, getAccountKey } = context;

  // Endpoint-throttle gate: while the usage API is throttling this machine
  // (HTTP 429 backoff deadline in ~/.oauth-switch/state.json), make ZERO
  // usage requests and render the stored snapshot instead. --force is the
  // genuinely manual escape hatch that bypasses the gate; the menu bar app's
  // timer-driven refresh must never pass it.
  const throttledUntil = options.force ? null : state.getProviderThrottleUntil('claude');
  if (throttledUntil) {
    console.log(`Usage API throttled, showing cached data, next attempt at ${new Date(throttledUntil).toLocaleTimeString()}.`);
    const currentKey = getAccountKey(config.oauthAccount);
    const entry = store.accounts.find((account) => account.key === currentKey);
    if (entry?.usageSnapshot) {
      for (const line of formatUsageInfo(entry.usageSnapshot)) console.log(line);
    } else {
      console.log('No cached usage data for the current account.');
    }
    return;
  }

  console.log('Fetching usage from Claude API...');
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
    // Record the new backoff deadline (exponential on consecutive 429s) so
    // every other caller stops hammering the endpoint.
    const until = state.setProviderThrottle('claude', apiThrottled.retryAfter);
    console.log(`Recorded usage-API backoff; next automatic attempt at ${new Date(until).toLocaleTimeString()}.`);
  } else if (currentUsage) {
    // Successful fetch: end any throttle episode and reset the streak.
    state.resetProviderThrottle('claude');
  }
  if (currentUsage) {
    for (const line of formatUsageInfo(currentUsage)) console.log(line);
  } else {
    console.log('No usage data available for the current account.');
  }
}

module.exports = { runUsageAction };
