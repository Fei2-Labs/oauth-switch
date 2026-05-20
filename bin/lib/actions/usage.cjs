async function runUsageAction(context) {
  const { store, config, fetchUsage, formatUsageInfo, setRateLimitResetAt, setRateLimitResetAtFromIso, ensureDir, refreshStoredUsageSnapshots, writeStore, options, getAccountKey } = context;
  console.log('Fetching usage from Claude API...');
  const { currentUsage, changed } = await refreshStoredUsageSnapshots(
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
  if (currentUsage) {
    for (const line of formatUsageInfo(currentUsage)) console.log(line);
  } else {
    console.log('No usage data available for the current account.');
  }
}

module.exports = { runUsageAction };
