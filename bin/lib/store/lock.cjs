const fs = require('fs');
const os = require('os');
const path = require('path');
const { logEvent } = require('../log.cjs');

// Cross-process advisory lock for OAuth-Switch store mutations. Claude OAuth
// uses ROTATING refresh tokens: each successful refresh invalidates the old
// token. When the menu bar's timer-driven `oas usage` process and a
// user-triggered `oas <selector>` switch process run concurrently, both call
// refreshOAuthToken() on the SAME refresh token; whichever lands second gets
// 400 invalid_grant and the switch is wrongly blocked. Serializing every
// Claude-store critical section behind one named lock removes that race.
//
// The lock file lives at ~/.oauth-switch/<lockName>.lock and is acquired with
// an exclusive create (O_EXCL). Availability beats strictness: if the lock
// cannot be taken within the timeout we proceed WITHOUT it rather than fail a
// user's switch.

const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_TIMEOUT_MS = 10 * 1000;
const LOCK_STALE_MS = 30 * 1000;

function getLockPath(lockName) {
  return path.join(os.homedir(), '.oauth-switch', `${lockName}.lock`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Acquire the named lock, run fn while holding it, and ALWAYS release in a
// finally (close fd + unlink). Returns whatever fn returns. On lock-acquire
// failure (timeout or unexpected fs error) it logs a warning and runs fn
// without the lock.
async function withStoreLock(lockName, fn) {
  const lockPath = getLockPath(lockName);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Cannot even ensure the directory: skip locking, never block the user.
    return fn();
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  while (fd === null) {
    try {
      // Exclusive create: succeeds only when the lock file does not exist.
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // Unexpected fs error (permissions, etc.): availability over strictness.
        logEvent('manual', `Store lock ${lockName}: open failed (${err.message}); proceeding without lock`);
        return fn();
      }
      // Lock is held by someone else. Break it if it is stale (the owner
      // crashed without releasing): an mtime older than LOCK_STALE_MS.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue; // retry the exclusive create immediately
        }
      } catch {
        // Lock vanished between open and stat (owner released): retry now.
        continue;
      }
      if (Date.now() >= deadline) {
        logEvent('manual', `Store lock ${lockName}: timed out after ${LOCK_TIMEOUT_MS}ms; proceeding without lock`);
        return fn();
      }
      await delay(LOCK_POLL_INTERVAL_MS);
    }
  }

  // Lock acquired. Record the pid for debuggability (best-effort).
  try {
    fs.writeSync(fd, String(process.pid));
  } catch {
    // pid write is non-essential.
  }

  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed: ignore.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already removed (e.g. broken as stale by another process): ignore.
    }
  }
}

module.exports = {
  withStoreLock,
  getLockPath,
  LOCK_POLL_INTERVAL_MS,
  LOCK_TIMEOUT_MS,
  LOCK_STALE_MS,
};
