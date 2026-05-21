const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const AUTH_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
const CLI_AUTH_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token-cli.json');
const STORE_PATH = path.join(os.homedir(), '.KiroMultiAccounts.json');
const BACKUP_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache', 'backups');
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
  const base = path.basename(filePath);
  fs.copyFileSync(filePath, path.join(BACKUP_DIR, `${base}.${ts}.bak`));
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith(base) && n.endsWith('.bak'))
    .sort().reverse();
  for (const stale of backups.slice(3)) {
    fs.rmSync(path.join(BACKUP_DIR, stale), { force: true });
  }
}

function getAccountKey(auth) {
  if (auth && auth.clientIdHash) return `kiro:${auth.clientIdHash}`;
  if (auth && auth.accessToken) return `kiro:${auth.accessToken.slice(0, 16)}`;
  return null;
}

function getDisplayName(auth) {
  const parts = [];
  if (auth.provider) parts.push(auth.provider);
  if (auth.authMethod) parts.push(`(${auth.authMethod})`);
  if (auth.region) parts.push(`[${auth.region}]`);
  if (auth.expiresAt) {
    const exp = new Date(auth.expiresAt);
    const now = new Date();
    if (exp > now) {
      const hours = Math.round((exp - now) / 3600000);
      parts.push(`expires in ${hours}h`);
    } else {
      parts.push('expired');
    }
  }
  return parts.join(' ') || 'unknown';
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

function syncCurrentAuth() {
  const auth = readJson(AUTH_PATH);
  if (!auth || !auth.accessToken) return { store: readStore(), currentKey: null };

  const key = getAccountKey(auth);
  if (!key) return { store: readStore(), currentKey: null };

  const store = readStore();
  const now = new Date().toISOString();
  const idx = store.accounts.findIndex((a) => a.key === key);

  const entry = {
    key,
    auth: JSON.parse(JSON.stringify(auth)),
    displayName: getDisplayName(auth),
    capturedAt: now,
    lastUsedAt: now,
  };

  if (idx >= 0) {
    entry.lastUsedAt = store.accounts[idx].lastUsedAt || now;
    store.accounts[idx] = entry;
  } else {
    store.accounts.push(entry);
  }

  writeStore(store);
  return { store, currentKey: key };
}

function listAccounts() {
  const { store, currentKey } = syncCurrentAuth();

  if (store.accounts.length === 0) {
    console.log('No Kiro accounts stored.');
    console.log('Log in with Kiro IDE first, then run `oas kiro` to capture.');
    return;
  }

  console.log('--- Kiro Accounts ---');
  store.accounts.forEach((account, index) => {
    const marker = account.key === currentKey ? ' ← active' : '';
    const expired = account.auth?.expiresAt && new Date(account.auth.expiresAt) < new Date() ? ' [expired]' : '';
    console.log(`  [${index}] ${account.displayName}${expired}${marker}`);
  });
  console.log('');
  console.log('Switch: oas kiro <index>');
  console.log('Remove: oas kiro remove <index>');
  console.log('Label:  oas kiro label <index> <name>');
}

function switchAccount(index) {
  const { store, currentKey } = syncCurrentAuth();
  const idx = Number.parseInt(index, 10);

  if (Number.isNaN(idx) || idx < 0 || idx >= store.accounts.length) {
    console.log(`Invalid index. Use 0–${store.accounts.length - 1}.`);
    process.exitCode = 1;
    return;
  }

  const target = store.accounts[idx];
  if (target.key === currentKey) {
    console.log(`Already on [${idx}] ${target.displayName}.`);
    return;
  }

  backupFile(AUTH_PATH);
  backupFile(CLI_AUTH_PATH);

  target.lastUsedAt = new Date().toISOString();
  writeStore(store);

  writeJson(AUTH_PATH, target.auth);
  if (fs.existsSync(CLI_AUTH_PATH)) {
    writeJson(CLI_AUTH_PATH, target.auth);
  }

  console.log(`Switched Kiro to [${idx}] ${target.displayName}.`);
  console.log('Restart Kiro IDE for the change to take effect.');
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

function labelAccount(index, newLabel) {
  const store = readStore();
  const idx = Number.parseInt(index, 10);

  if (Number.isNaN(idx) || idx < 0 || idx >= store.accounts.length) {
    console.log(`Invalid index. Use 0–${store.accounts.length - 1}.`);
    process.exitCode = 1;
    return;
  }
  if (!newLabel) {
    console.log('Usage: oas kiro label <index> <name>');
    process.exitCode = 1;
    return;
  }

  store.accounts[idx].displayName = newLabel;
  writeStore(store);
  console.log(`Renamed [${idx}] to "${newLabel}".`);
}

function runKiro(args) {
  const subcommand = args[0];

  if (!subcommand) {
    listAccounts();
    return;
  }

  if (subcommand === 'remove') {
    removeAccount(args[1]);
    return;
  }

  if (subcommand === 'label') {
    labelAccount(args[1], args.slice(2).join(' '));
    return;
  }

  const numeric = Number.parseInt(subcommand, 10);
  if (!Number.isNaN(numeric) && String(numeric) === subcommand) {
    switchAccount(subcommand);
    return;
  }

  console.log(`Unknown kiro subcommand: ${subcommand}`);
  process.exitCode = 1;
}

module.exports = { runKiro, AUTH_PATH, CLI_AUTH_PATH, STORE_PATH };
