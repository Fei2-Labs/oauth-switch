const fs = require('fs');
const {
  getDefaultStorePath,
  getDefaultBackupDir,
  readJsonIfExists,
  writeStore,
} = require('../store/io.cjs');
const { normalizeStore } = require('../store/accounts.cjs');
const { withStoreLock } = require('../store/lock.cjs');
const switchLog = require('../log.cjs');

// Keep in sync with the STORE_VERSION in bin/oauth-switch.cjs. Only used as a
// fallback when the on-disk store has no version yet; an existing version is
// preserved so writing a cookie snapshot never silently bumps the store.
const STORE_VERSION = '0.2.9';

// Claude provider subcommands: `oas claude <sub> ...`.
//
// Today the only subcommand is `set-usage-snapshot`, the SINGLE-WRITER seam the
// macOS app uses to persist a cookie-sourced usage snapshot into the Claude
// store. The app reads claude.ai usage via the browser cookie (URLSession) but
// NEVER writes the store JSON itself; it shells this command so every store
// mutation still goes through Node under withStoreLock('claude-store').
async function runClaude(args) {
  const sub = args[0];
  if (sub === 'set-usage-snapshot') {
    await runSetUsageSnapshot(args.slice(1));
    return;
  }
  console.log('Usage: oas claude set-usage-snapshot --key <accountKey> --snapshot-file <path>');
  process.exitCode = 1;
}

function parseFlags(args) {
  const out = {};
  const list = [...args];
  while (list.length > 0) {
    const flag = list.shift();
    if (flag === '--key') out.key = list.shift();
    else if (flag === '--snapshot-file') out.snapshotFile = list.shift();
  }
  return out;
}

async function runSetUsageSnapshot(args, deps = {}) {
  const storePath = deps.storePath || getDefaultStorePath();
  const backupDir = deps.backupDir || getDefaultBackupDir();
  const { key, snapshotFile } = parseFlags(args);

  if (!key || !snapshotFile) {
    console.log('Usage: oas claude set-usage-snapshot --key <accountKey> --snapshot-file <path>');
    process.exitCode = 1;
    return;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  } catch (err) {
    console.log(`Could not read snapshot file: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const invalidReason = validateSnapshotShape(snapshot);
  if (invalidReason) {
    console.log(`Invalid usage snapshot: ${invalidReason}`);
    process.exitCode = 1;
    return;
  }

  await withStoreLock('claude-store', async () => {
    const result = applyUsageSnapshot({ storePath, backupDir, key, snapshot });
    if (!result.ok) {
      console.log(`No stored account with key '${key}'. Nothing updated.`);
      process.exitCode = 1;
      return;
    }
    const name = result.entry.metadata?.emailAddress || key;
    switchLog.logEvent('manual', `Set cookie usage snapshot for ${name}`);
    console.log(`Updated usage snapshot for [${result.index}] ${name} (source: cookie).`);
  });
}

// Returns a human reason string when the snapshot is malformed, or null when it
// is acceptable. Minimal validation: it must be an object carrying at least one
// of the known usage windows, and any present window must itself be an object.
function validateSnapshotShape(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return 'expected a JSON object';
  }
  const hasFiveHour = snapshot.five_hour !== undefined && snapshot.five_hour !== null;
  const hasSevenDay = snapshot.seven_day !== undefined && snapshot.seven_day !== null;
  if (!hasFiveHour && !hasSevenDay) {
    return 'expected five_hour and/or seven_day';
  }
  if (hasFiveHour && typeof snapshot.five_hour !== 'object') {
    return 'five_hour must be an object';
  }
  if (hasSevenDay && typeof snapshot.seven_day !== 'object') {
    return 'seven_day must be an object';
  }
  return null;
}

function sanitizeWindow(window) {
  if (!window || typeof window !== 'object') return undefined;
  return { utilization: window.utilization, resets_at: window.resets_at };
}

// Reduce the incoming snapshot to the exact stored shape (five_hour / seven_day
// / fetchedAt), dropping any model-specific or extra fields. undefined windows
// are omitted by JSON.stringify on write, mirroring toUsageSnapshot.
function sanitizeSnapshot(snapshot) {
  return {
    five_hour: sanitizeWindow(snapshot.five_hour),
    seven_day: sanitizeWindow(snapshot.seven_day),
    fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : new Date().toISOString(),
  };
}

// Mutates the store file at `storePath`: sets the matched account's
// usageSnapshot (sanitized) and a `usageSource: 'cookie'` marker. Returns
// { ok: false } (no write) when the key matches no stored account.
function applyUsageSnapshot({ storePath, backupDir, key, snapshot }) {
  const raw = readJsonIfExists(storePath, { version: STORE_VERSION, accounts: [] });
  const store = normalizeStore(raw, (raw && raw.version) || STORE_VERSION);
  const index = store.accounts.findIndex((entry) => entry && entry.key === key);
  if (index < 0) {
    return { ok: false };
  }
  store.accounts[index].usageSnapshot = sanitizeSnapshot(snapshot);
  store.accounts[index].usageSource = 'cookie';
  store.updatedAt = new Date().toISOString();
  writeStore(store, { storePath, backupDir });
  return { ok: true, index, entry: store.accounts[index] };
}

module.exports = {
  runClaude,
  runSetUsageSnapshot,
  applyUsageSnapshot,
  validateSnapshotShape,
  sanitizeSnapshot,
};
