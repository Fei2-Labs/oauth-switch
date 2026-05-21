const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const STORE_PATH = path.join(os.homedir(), '.CodexMultiAccounts.json');
const BACKUP_DIR = path.join(os.homedir(), '.codex', 'backups', 'multi-account-switch');
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

function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

function extractAccountInfo(auth) {
  if (!auth || !auth.tokens) return null;
  const payload = decodeJwtPayload(auth.tokens.id_token || auth.tokens.access_token);
  if (!payload) return null;
  const authInfo = payload['https://api.openai.com/auth'] || {};
  return {
    email: payload.email || null,
    name: payload.name || null,
    userId: authInfo.chatgpt_user_id || null,
    accountId: auth.tokens.account_id || authInfo.chatgpt_account_id || null,
    planType: authInfo.chatgpt_plan_type || null,
    orgs: authInfo.organizations || [],
  };
}

function getAccountKey(auth) {
  const info = extractAccountInfo(auth);
  if (info && info.accountId) return `account:${info.accountId}`;
  if (info && info.email) return `email:${info.email}`;
  if (auth && auth.OPENAI_API_KEY) return `key:${auth.OPENAI_API_KEY.slice(0, 12)}`;
  return null;
}

function getDisplayName(auth) {
  const info = extractAccountInfo(auth);
  if (!info) return 'unknown';
  const parts = [];
  if (info.name) parts.push(info.name);
  if (info.email) parts.push(`<${info.email}>`);
  if (info.planType) parts.push(`(${info.planType})`);
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
  if (!auth) return { store: readStore(), currentKey: null };

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
    console.log('No Codex accounts stored.');
    console.log('Log in with `codex login --device-auth` first.');
    return;
  }

  console.log('--- Codex Accounts ---');
  store.accounts.forEach((account, index) => {
    const marker = account.key === currentKey ? ' ← active' : '';
    console.log(`  [${index}] ${account.displayName}${marker}`);
  });
  console.log('');
  console.log('Switch: oas codex <index>');
  console.log('Remove: oas codex remove <index>');
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
  target.lastUsedAt = new Date().toISOString();
  writeStore(store);
  writeJson(AUTH_PATH, target.auth);

  console.log(`Switched Codex to [${idx}] ${target.displayName}.`);
  console.log('Restart Codex for the change to take effect.');
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

function runCodex(args) {
  const subcommand = args[0];

  if (!subcommand) {
    listAccounts();
    return;
  }

  if (subcommand === 'remove') {
    removeAccount(args[1]);
    return;
  }

  const numeric = Number.parseInt(subcommand, 10);
  if (!Number.isNaN(numeric) && String(numeric) === subcommand) {
    switchAccount(subcommand);
    return;
  }

  console.log(`Unknown codex subcommand: ${subcommand}`);
  process.exitCode = 1;
}

module.exports = { runCodex };
