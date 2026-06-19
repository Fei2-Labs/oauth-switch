const fs = require('fs');
const os = require('os');
const path = require('path');

// Self-update + non-intrusive update-check for the oauth-switch CLI.
//
// `checkForUpdate` answers "is a newer published version available?" cheaply:
// it caches the registry's latest version in ~/.oauth-switch/update-check.json
// and only hits the npm registry at most once per 24h. The registry call has a
// short timeout and fails silently — a missing network must never block or
// error a command. `runSelfUpdate` shells out to npm to install the latest.
//
// Everything network/FS/time-dependent is injectable so tests run with fakes
// and never touch the real registry, filesystem, or clock.

const PACKAGE_NAME = 'oauth-switch';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most one registry hit per day
const REGISTRY_TIMEOUT_MS = 3000; // short — never hang a command on the network
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

function getCachePath() {
  // Overridable for tests / sandboxed runs so they never touch the real file.
  return process.env.OAUTH_SWITCH_UPDATE_CACHE_PATH
    || path.join(getStateDir(), 'update-check.json');
}

function getStateDir() {
  // OAUTH_SWITCH_STATE_PATH points at a state *file*; reuse its directory so
  // tests that redirect state also redirect the update cache.
  const statePath = process.env.OAUTH_SWITCH_STATE_PATH;
  if (statePath) return path.dirname(statePath);
  return path.join(os.homedir(), '.oauth-switch');
}

// Compares two "major.minor.patch" version strings numerically (no dependency).
// Returns 1 if a > b, -1 if a < b, 0 if equal. Non-numeric / missing segments
// are treated as 0, so "1.10.0" > "1.9.0" and "1.2" == "1.2.0".
function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i], 10) || 0;
    const nb = Number.parseInt(pb[i], 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or corrupt cache: treat as no cache.
  }
  return null;
}

function writeCache(cachePath, value) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // Never propagate cache-write errors to the caller.
  }
}

// Hits the npm registry's lightweight `/latest` endpoint for the published
// version, with a short timeout. Rejects on any error/timeout so the caller can
// fall back to cache and fail silently.
function defaultFetchLatest() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(REGISTRY_URL, { timeout: REGISTRY_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`registry responded ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const version = JSON.parse(body).version;
          if (typeof version === 'string' && version) resolve(version);
          else reject(new Error('no version in registry response'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('registry request timed out')); });
    req.on('error', reject);
  });
}

// Resolves { updateAvailable, latest }. Never throws: an offline registry, a
// timeout, or a corrupt cache all degrade to { updateAvailable: false }.
//
//   cachePath      where the latest-version cache lives (injectable for tests)
//   currentVersion the running CLI version (from package.json)
//   now            current time (ms epoch; injectable for tests)
//   fetchLatest    () => Promise<string> resolving the registry's latest version
async function checkForUpdate({ cachePath, currentVersion, now = Date.now(), fetchLatest = defaultFetchLatest } = {}) {
  const resolvedCachePath = cachePath || getCachePath();
  const cache = readCache(resolvedCachePath);

  // Fresh cache (<24h): use it, no network call.
  if (cache && typeof cache.checkedAt === 'number' && typeof cache.latest === 'string'
    && (now - cache.checkedAt) < CHECK_INTERVAL_MS) {
    return buildResult(cache.latest, currentVersion);
  }

  // Stale or missing cache: try the registry, fail silently on any error.
  let latest = null;
  try {
    latest = await fetchLatest();
  } catch {
    // Offline / timeout / registry down — fall back to any cached value.
    if (cache && typeof cache.latest === 'string') {
      return buildResult(cache.latest, currentVersion);
    }
    return { updateAvailable: false, latest: null };
  }

  if (typeof latest !== 'string' || !latest) {
    if (cache && typeof cache.latest === 'string') {
      return buildResult(cache.latest, currentVersion);
    }
    return { updateAvailable: false, latest: null };
  }

  writeCache(resolvedCachePath, { latest, checkedAt: now });
  return buildResult(latest, currentVersion);
}

function buildResult(latest, currentVersion) {
  return {
    updateAvailable: compareVersions(latest, currentVersion) > 0,
    latest,
  };
}

// Shells out to `npm install -g oauth-switch@latest`, streaming npm's output so
// the user sees progress. On success prints the installed version and a restart
// hint. On failure prints a clear manual-fallback command (with a sudo/prefix
// hint for EACCES) without swallowing npm's real error. Resolves the npm exit
// code (0 on success).
function runSelfUpdate({ spawn, log = console.log, errorLog = console.error } = {}) {
  const spawnImpl = spawn || require('child_process').spawn;
  return new Promise((resolve) => {
    log(`Updating ${PACKAGE_NAME} to the latest version...`);
    log(`Running: npm install -g ${PACKAGE_NAME}@latest`);

    let child;
    try {
      child = spawnImpl('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'inherit' });
    } catch (err) {
      printUpdateFallback(errorLog, err);
      resolve(1);
      return;
    }

    child.on('error', (err) => {
      // npm not found (ENOENT) or not spawnable.
      printUpdateFallback(errorLog, err);
      resolve(1);
    });

    child.on('close', (code) => {
      if (code === 0) {
        log('');
        let version = null;
        try {
          // Resolve the freshly installed package's version, if visible.
          delete require.cache[require.resolve(`${PACKAGE_NAME}/package.json`)];
          version = require(`${PACKAGE_NAME}/package.json`).version;
        } catch {
          // Globally installed copy not resolvable from here — that's fine.
        }
        if (version) log(`Updated to ${PACKAGE_NAME} ${version}.`);
        else log(`Updated ${PACKAGE_NAME} to the latest version.`);
        log('Restart the menu bar app / re-run the command to use it.');
        resolve(0);
        return;
      }
      printUpdateFallback(errorLog, new Error(`npm exited with code ${code}`));
      resolve(code || 1);
    });
  });
}

function printUpdateFallback(errorLog, err) {
  const message = err && err.message ? err.message : String(err);
  errorLog(`Update failed: ${message}`);
  const isEacces = err && (err.code === 'EACCES' || /EACCES|permission/i.test(message));
  const isEnoent = err && (err.code === 'ENOENT' || /ENOENT|not found/i.test(message));
  if (isEnoent) {
    errorLog('npm was not found on your PATH. Install Node.js/npm, then run:');
    errorLog(`  npm install -g ${PACKAGE_NAME}@latest`);
    return;
  }
  errorLog('Run this manually to update:');
  errorLog(`  npm install -g ${PACKAGE_NAME}@latest`);
  if (isEacces) {
    errorLog('Permission denied. Either run with elevated privileges:');
    errorLog(`  sudo npm install -g ${PACKAGE_NAME}@latest`);
    errorLog('or fix your npm global prefix so it does not require sudo:');
    errorLog('  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally');
  }
}

// Prints the one-line "update available" notice when a newer version exists.
// Wraps checkForUpdate so callers stay one line. Honors the opt-out env var and
// fails silently. Returns true if a notice was printed.
async function maybePrintUpdateNotice({ currentVersion, log = console.log, now = Date.now(), fetchLatest, cachePath } = {}) {
  if (process.env.OAUTH_SWITCH_NO_UPDATE_CHECK === '1') return false;
  try {
    const { updateAvailable, latest } = await checkForUpdate({ cachePath, currentVersion, now, fetchLatest });
    if (updateAvailable && latest) {
      log(`Update available: ${currentVersion} -> ${latest}. Run: oas update`);
      return true;
    }
  } catch {
    // Never let the update check break a command.
  }
  return false;
}

module.exports = {
  PACKAGE_NAME,
  CHECK_INTERVAL_MS,
  REGISTRY_TIMEOUT_MS,
  REGISTRY_URL,
  getCachePath,
  compareVersions,
  checkForUpdate,
  runSelfUpdate,
  maybePrintUpdateNotice,
};
