const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchCodexUsage, toCodexUsageSnapshot } = require('../actions/auto-switch.cjs');
const { logEvent } = require('../log.cjs');
const {
  decodeJwtPayload,
  getCodexAccountKey,
  getLegacyCodexAccountKey,
  getCodexDisplayName,
  getDisplayCodexAccounts,
} = require('./codex-identity.cjs');

const AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const STORE_PATH = path.join(os.homedir(), '.CodexMultiAccounts.json');
const BACKUP_DIR = path.join(os.homedir(), '.codex', 'backups', 'multi-account-switch');
const MANAGED_HOME_ROOT = path.join(os.homedir(), '.OAuthSwitch', 'codex-homes');
const STORE_VERSION = '1.0.0';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  ensureDir(BACKUP_DIR);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  fs.copyFileSync(filePath, path.join(BACKUP_DIR, `auth.json.${ts}.bak`));
  const backups = fs.readdirSync(BACKUP_DIR).filter((n) => n.endsWith('.bak')).sort().reverse();
  for (const stale of backups.slice(3)) {
    fs.rmSync(path.join(BACKUP_DIR, stale), { force: true });
  }
}

function getAccountKey(auth) {
  return getCodexAccountKey(auth);
}

function getDisplayName(auth) {
  return getCodexDisplayName(auth);
}

function readStore() {
  const raw = readJson(STORE_PATH);
  if (!raw || !Array.isArray(raw.accounts)) {
    return { version: STORE_VERSION, accounts: [] };
  }
  return raw;
}

function writeStore(store) {
  store.updatedAt = new Date().toISOString();
  writeJson(STORE_PATH, store);
}

function upsertAuthSnapshot(store, auth, now, options = {}) {
  const key = getAccountKey(auth);
  if (!key) return null;
  const legacyKey = getLegacyCodexAccountKey(auth);
  let idx = store.accounts.findIndex((a) => a.key === key);
  if (idx < 0 && legacyKey) {
    idx = store.accounts.findIndex((a) => a.key === legacyKey);
  }

  const entry = {
    key,
    auth: JSON.parse(JSON.stringify(auth)),
    displayName: getDisplayName(auth),
    capturedAt: options.capturedAt || now,
    lastUsedAt: options.lastUsedAt || now,
    managedHomePath: options.managedHomePath || undefined,
  };

  if (idx >= 0) {
    entry.lastUsedAt = store.accounts[idx].lastUsedAt || entry.lastUsedAt;
    entry.usageSnapshot = store.accounts[idx].usageSnapshot;
    entry.managedHomePath = options.managedHomePath || store.accounts[idx].managedHomePath || undefined;
    entry.disabled = store.accounts[idx].disabled || undefined;
    store.accounts[idx] = entry;
  } else {
    store.accounts.push(entry);
  }
  return key;
}

function importBackupAuthSnapshots(store) {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  let imported = 0;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^auth\.json\..+\.bak$/.test(name))
    .sort();

  for (const file of files) {
    const filePath = path.join(BACKUP_DIR, file);
    const auth = readJson(filePath);
    if (!auth?.tokens && !auth?.OPENAI_API_KEY) continue;
    const before = JSON.stringify(store.accounts.map((account) => account.key));
    const stat = fs.statSync(filePath);
    upsertAuthSnapshot(store, auth, new Date(stat.mtimeMs).toISOString(), {
      capturedAt: new Date(stat.mtimeMs).toISOString(),
      lastUsedAt: new Date(stat.mtimeMs).toISOString(),
    });
    const after = JSON.stringify(store.accounts.map((account) => account.key));
    if (before !== after) imported += 1;
  }
  return imported;
}

function importManagedHomeAuthSnapshots(store) {
  if (!fs.existsSync(MANAGED_HOME_ROOT)) return 0;
  let imported = 0;
  const homes = fs.readdirSync(MANAGED_HOME_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(MANAGED_HOME_ROOT, entry.name))
    .sort();

  for (const homePath of homes) {
    const authPath = path.join(homePath, 'auth.json');
    const auth = readJson(authPath);
    if (!auth?.tokens && !auth?.OPENAI_API_KEY) continue;
    const before = JSON.stringify(store.accounts.map((account) => [
      account.key,
      account.managedHomePath || null,
    ]));
    const stat = fs.statSync(authPath);
    upsertAuthSnapshot(store, auth, new Date(stat.mtimeMs).toISOString(), {
      capturedAt: new Date(stat.mtimeMs).toISOString(),
      lastUsedAt: new Date(stat.mtimeMs).toISOString(),
      managedHomePath: homePath,
    });
    const after = JSON.stringify(store.accounts.map((account) => [
      account.key,
      account.managedHomePath || null,
    ]));
    if (before !== after) imported += 1;
  }
  return imported;
}

function syncCurrentAuth() {
  const auth = readJson(AUTH_PATH);
  const store = readStore();
  const importedBackups = importBackupAuthSnapshots(store);
  const importedManagedHomes = importManagedHomeAuthSnapshots(store);
  if (!auth) {
    if (importedBackups > 0 || importedManagedHomes > 0) writeStore(store);
    return { store, currentKey: null, importedBackups, importedManagedHomes };
  }

  const key = getAccountKey(auth);
  if (!key) {
    if (importedBackups > 0 || importedManagedHomes > 0) writeStore(store);
    return { store, currentKey: null, importedBackups, importedManagedHomes };
  }
  const now = new Date().toISOString();
  upsertAuthSnapshot(store, auth, now);

  writeStore(store);
  return { store, currentKey: key, importedBackups, importedManagedHomes };
}

async function syncUsage() {
  const { store, currentKey } = syncCurrentAuth();
  if (store.accounts.length === 0) {
    console.log('No Codex accounts stored.');
    process.exitCode = 1;
    return;
  }

  let synced = 0;
  let failed = 0;
  let throttled = false;
  let currentSynced = false;
  const now = new Date().toISOString();
  for (const [idx, account] of store.accounts.entries()) {
    const accessToken = account.auth?.tokens?.access_token;
    if (!accessToken) continue;
    try {
      const usage = await fetchCodexUsage(accessToken);
      if (usage?.api_throttled) {
        // Endpoint throttling of this machine: keep the old snapshots and
        // stop fetching — further requests would only extend the throttle.
        throttled = true;
        break;
      }
      const snapshot = toCodexUsageSnapshot(usage, now);
      store.accounts[idx].usageSnapshot = snapshot;
      synced += 1;
      if (account.key === currentKey) currentSynced = true;
    } catch {
      failed += 1;
    }
  }

  writeStore(store);
  const parts = [`Synced Codex usage for ${synced} account(s).`];
  if (failed > 0) parts.push(`${failed} failed.`);
  if (throttled) parts.push('Usage API is throttling this machine (HTTP 429); kept previous snapshots for the rest.');
  if (!currentSynced && currentKey) parts.push('Current account was not refreshed.');
  console.log(parts.join(' '));
}

async function addManagedCodexAccount() {
  const { spawnSync } = require('child_process');
  ensureDir(MANAGED_HOME_ROOT);
  const id = require('crypto').randomUUID();
  const managedHomePath = path.join(MANAGED_HOME_ROOT, id);
  ensureDir(managedHomePath);

  console.log(`Starting Codex login in managed home: ${managedHomePath}`);
  const result = spawnSync('codex', ['login', '--device-auth'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_HOME: managedHomePath,
    },
  });

  if (result.error) {
    console.log(`Failed to start codex login: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0) {
    console.log(`codex login exited with status ${result.status}.`);
    process.exitCode = result.status || 1;
    return;
  }

  const auth = readJson(path.join(managedHomePath, 'auth.json'));
  if (!auth?.tokens && !auth?.OPENAI_API_KEY) {
    console.log('Managed Codex login completed but no auth.json was found.');
    process.exitCode = 1;
    return;
  }

  const store = readStore();
  const key = upsertAuthSnapshot(store, auth, new Date().toISOString(), { managedHomePath });
  writeStore(store);
  console.log(`Added managed Codex account: ${getDisplayName(auth)}.`);
  console.log(`Stored key: ${key}`);
  console.log('Run `oas codex sync-usage` to refresh quota for all saved Codex accounts.');
}

async function syncCurrentUsageOnly(auth, store, currentKey) {
  const idx = store.accounts.findIndex((account) => account.key === currentKey);
  if (idx < 0) {
    console.log('Current Codex account is not stored.');
    process.exitCode = 1;
    return;
  }

  try {
    const usage = await fetchCodexUsage(auth.tokens.access_token);
    if (usage?.api_throttled) {
      console.log('Codex usage API is throttling this machine (HTTP 429). Kept the previous snapshot; try again later.');
      return;
    }
    store.accounts[idx].usageSnapshot = toCodexUsageSnapshot(usage);
    writeStore(store);
    console.log('Synced Codex usage.');
  } catch (error) {
    console.log(`Failed to sync Codex usage: ${error.message}`);
    process.exitCode = 1;
  }
}

function listAccounts() {
  const auth = readJson(AUTH_PATH);
  const { store, importedBackups, importedManagedHomes } = syncCurrentAuth();

  if (store.accounts.length === 0) {
    console.log('No Codex accounts stored.');
    console.log('Auto-detect checked ~/.codex/auth.json and ~/.codex/backups/multi-account-switch/*.bak.');
    console.log('Run `codex login --device-auth`, then `oas codex`, for each Codex account that has no local token yet.');
    return;
  }

  console.log('--- Codex Accounts ---');
  if (importedBackups > 0) {
    console.log(`Auto-imported ${importedBackups} Codex auth backup snapshot(s).`);
  }
  if (importedManagedHomes > 0) {
    console.log(`Auto-imported ${importedManagedHomes} managed Codex home snapshot(s).`);
  }
  getDisplayCodexAccounts(store, auth).forEach((account) => {
    const marker = account.current ? ' ← active' : '';
    const disabledMarker = account.disabled ? ' (disabled)' : '';
    console.log(`  [${account.index}] ${account.displayName}${disabledMarker}${marker}`);
  });
  console.log('');
  console.log('Auto-detect: current ~/.codex/auth.json, saved snapshots, auth backups, and ~/.OAuthSwitch/codex-homes.');
  console.log('Add:     oas codex add');
  console.log('Switch:  oas codex <index|name>');
  console.log('Alias:   oas codex alias <index> <name>');
  console.log('Remove:  oas codex remove <index>');
  console.log('Disable: oas codex disable <index> (auto-switch skips it)');
  console.log('Enable:  oas codex enable <index>');
}

function switchAccount(index) {
  const { store, currentKey } = syncCurrentAuth();
  const displayAccounts = getDisplayCodexAccounts(store, readJson(AUTH_PATH));
  const idx = resolveCodexIndex(displayAccounts, index);

  if (idx === null) {
    process.exitCode = 1;
    return;
  }

  const target = store.accounts[idx];
  if (target.key === currentKey) {
    console.log(`Already on [${idx}] ${target.displayName}.`);
    return;
  }

  const managedAuth = target.managedHomePath
    ? readJson(path.join(target.managedHomePath, 'auth.json'))
    : null;
  if (managedAuth?.tokens || managedAuth?.OPENAI_API_KEY) {
    target.auth = managedAuth;
  }

  backupFile(AUTH_PATH);
  target.lastUsedAt = new Date().toISOString();
  writeStore(store);
  writeJson(AUTH_PATH, target.auth);

  logEvent('manual', `Switched Codex to ${target.displayName}`);
  // Manual switches express user intent: reset the auto-switch cooldown.
  require('../store/state.cjs').clearAutoSwitchCooldown('codex');
  console.log(`Switched Codex to [${idx}] ${target.displayName}.`);
  console.log('Restart Codex for the change to take effect.');
}

function resolveCodexIndex(accounts, selector) {
  const trimmed = String(selector).trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(numeric) && String(numeric) === trimmed) {
    const byIndex = accounts.find((account) => Number(account.index) === numeric);
    if (!byIndex) {
      const validIndexes = accounts.map((account) => account.index).join(', ');
      console.log(`Invalid index. Use one of: ${validIndexes}.`);
      return null;
    }
    return byIndex.index;
  }
  const lower = trimmed.toLowerCase();
  const byName = accounts.find((a) => a.displayName && a.displayName.toLowerCase().includes(lower));
  if (byName) return byName.index;
  const byKey = accounts.find((a) => a.key && a.key.toLowerCase() === lower);
  if (byKey) return byKey.index;
  console.log(`No account matched '${trimmed}'. Use index or name.`);
  return null;
}

function removeAccount(index) {
  const store = readStore();
  const idx = Number.parseInt(index, 10);

  if (Number.isNaN(idx) || idx < 0 || idx >= store.accounts.length) {
    console.log(`Invalid index. Use 0–${store.accounts.length - 1}.`);
    process.exitCode = 1;
    return;
  }

  const removed = store.accounts.splice(idx, 1)[0];
  writeStore(store);
  console.log(`Removed [${idx}] ${removed.displayName}.`);
}

function setAccountDisabled(index, disabled) {
  const store = readStore();
  const idx = Number.parseInt(index, 10);

  if (Number.isNaN(idx) || idx < 0 || idx >= store.accounts.length) {
    console.log(`Invalid index. Use 0–${store.accounts.length - 1}.`);
    process.exitCode = 1;
    return;
  }

  if (disabled) {
    store.accounts[idx].disabled = true;
  } else {
    delete store.accounts[idx].disabled;
  }
  writeStore(store);
  if (disabled) {
    logEvent('manual', `Disabled Codex account ${store.accounts[idx].displayName}`);
    console.log(`Disabled [${idx}] ${store.accounts[idx].displayName}. Auto-switch will skip this account.`);
  } else {
    logEvent('manual', `Enabled Codex account ${store.accounts[idx].displayName}`);
    console.log(`Enabled [${idx}] ${store.accounts[idx].displayName}. Auto-switch can pick this account again.`);
  }
}

async function runCodex(args) {
  const subcommand = args[0];

  if (!subcommand) {
    listAccounts();
    return;
  }

  if (subcommand === 'sync-usage') {
    await syncUsage();
    return;
  }

  if (subcommand === 'add') {
    await addManagedCodexAccount();
    return;
  }

  if (subcommand === 'remove') {
    removeAccount(args[1]);
    return;
  }

  if (subcommand === 'disable') {
    setAccountDisabled(args[1], true);
    return;
  }

  if (subcommand === 'enable') {
    setAccountDisabled(args[1], false);
    return;
  }

  if (subcommand === 'alias') {
    labelAccount(args[1], args.slice(2).join(' '));
    return;
  }

  // Try as index or name
  switchAccount(subcommand);
}

function labelAccount(index, newLabel) {
  const store = readStore();
  const idx = Number.parseInt(index, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= store.accounts.length) {
    console.log(`Invalid index. Use 0–${store.accounts.length - 1}.`);
    process.exitCode = 1;
    return;
  }
  if (!newLabel) {
    console.log('Usage: oas codex label <index> <name>');
    process.exitCode = 1;
    return;
  }
  store.accounts[idx].displayName = newLabel;
  writeStore(store);
  console.log(`Renamed [${idx}] to "${newLabel}".`);
}

module.exports = { runCodex };
