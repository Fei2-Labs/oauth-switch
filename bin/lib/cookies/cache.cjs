const fs = require('fs');
const os = require('os');
const path = require('path');

// Read-only view of the per-account claude.ai cookie cache written by the macOS
// app (CookieCacheService) at ~/.oauth-switch/cookies.json. The Node CLI never
// writes this file (the sessionKey is a browser secret captured app-side); it
// only needs to know WHICH accounts have a usable cookie so it can SKIP the
// rotating-OAuth refresh for them (the app populates their usage via the web
// API instead). A missing or corrupt file degrades to an empty cache, so the
// daemon keeps its existing OAuth behavior for every account.

function getDefaultCookieCachePath() {
  return path.join(os.homedir(), '.oauth-switch', 'cookies.json');
}

// Returns a map of accountKey -> cached cookie object. Never throws.
function loadCookieCache(cachePath = getDefaultCookieCachePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

module.exports = {
  getDefaultCookieCachePath,
  loadCookieCache,
};
