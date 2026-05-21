const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const AUTH_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
const CLI_AUTH_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token-cli.json');
const SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');
const STORE_PATH = path.join(os.homedir(), '.KiroMultiAccounts.json');
const BACKUP_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache', 'backups');
const STORE_VERSION = '1.0.0';
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev';

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
  // profileArn is the most stable unique identifier per account
  if (auth && auth.profileArn) return `kiro:${auth.profileArn}`;
  if (auth && auth.accessToken) return `kiro:${auth.accessToken.slice(0, 24)}`;
  return null;
}

function getDisplayName(auth) {
  const parts = [];
  if (auth.provider) parts.push(auth.provider);
  if (auth.authMethod) parts.push(`(${auth.authMethod})`);
  if (auth.region) parts.push(`[${auth.region}]`);
  // clientIdHash-style files have scopes but no provider
  if (!auth.provider && auth.scopes) {
    parts.push('Kiro IDE session');
  }
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

function isKiroTokenFile(obj) {
  // Must have a real accessToken (not just clientSecret)
  if (!obj || !obj.accessToken) return false;
  // kiro-auth-token.json style: has provider + authMethod
  if (obj.provider && obj.authMethod) return true;
  // Other style: has accessToken + refreshToken + profileArn
  if (obj.refreshToken && obj.profileArn) return true;
  return false;
}

function scanSsoCacheForKiroTokens() {
  if (!fs.existsSync(SSO_CACHE_DIR)) return [];
  const files = fs.readdirSync(SSO_CACHE_DIR).filter((f) => f.endsWith('.json'));
  const tokens = [];
  for (const file of files) {
    if (file.startsWith('backups')) continue;
    const filePath = path.join(SSO_CACHE_DIR, file);
    try {
      const obj = readJson(filePath);
      if (isKiroTokenFile(obj)) {
        tokens.push({ filePath, auth: obj });
      }
    } catch (_) {}
  }
  return tokens;
}

function syncCurrentAuth() {
  // Scan all SSO cache files for Kiro tokens
  const tokenFiles = scanSsoCacheForKiroTokens();
  const store = readStore();
  const now = new Date().toISOString();

  for (const { filePath, auth } of tokenFiles) {
    const key = getAccountKey(auth);
    if (!key) continue;

    const idx = store.accounts.findIndex((a) => a.key === key);
    const entry = {
      key,
      auth: JSON.parse(JSON.stringify(auth)),
      displayName: getDisplayName(auth),
      sourceFile: filePath,
      capturedAt: now,
      lastUsedAt: now,
    };

    if (idx >= 0) {
      entry.lastUsedAt = store.accounts[idx].lastUsedAt || now;
      store.accounts[idx] = { ...store.accounts[idx], ...entry };
    } else {
      store.accounts.push(entry);
    }
  }

  writeStore(store);

  // Determine active key from kiro-auth-token.json
  const activeAuth = readJson(AUTH_PATH);
  const currentKey = activeAuth ? getAccountKey(activeAuth) : null;

  return { store, currentKey };
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

async function switchAccount(index) {
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

  if (!target.auth || !target.auth.refreshToken) {
    console.log(`Account [${idx}] has no refreshToken. Cannot switch.`);
    process.exitCode = 1;
    return;
  }

  await refreshAndSwitch(target, store, idx);
}

async function refreshAndSwitch(target, store, idx) {
  const auth = target.auth;
  const isSocial = auth.authMethod === 'social' || auth.provider === 'Google' || auth.provider === 'Github';

  let newAccessToken = auth.accessToken;
  let newRefreshToken = auth.refreshToken;

  if (isSocial) {
    const result = await refreshSocialToken(auth.refreshToken);
    if (result.success) {
      newAccessToken = result.accessToken;
      newRefreshToken = result.refreshToken || auth.refreshToken;
    } else {
      console.log(`Warning: token refresh failed (${result.error}), using existing token.`);
    }
  } else {
    // Need clientId and clientSecret from the SSO cache
    const clientData = findClientRegistration(auth.clientIdHash);
    if (clientData) {
      const result = await refreshOidcToken(auth.refreshToken, clientData.clientId, clientData.clientSecret, auth.region || 'us-east-1');
      if (result.success) {
        newAccessToken = result.accessToken;
        newRefreshToken = result.refreshToken || auth.refreshToken;
      } else {
        console.log(`Warning: token refresh failed (${result.error}), using existing token.`);
      }
    }
  }

  backupFile(AUTH_PATH);

  const tokenData = isSocial ? {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    profileArn: auth.profileArn,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    authMethod: 'social',
    provider: auth.provider,
  } : {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    clientIdHash: auth.clientIdHash,
    authMethod: auth.authMethod || 'IdC',
    provider: auth.provider || 'BuilderId',
    region: auth.region || 'us-east-1',
    profileArn: auth.profileArn,
  };

  writeJson(AUTH_PATH, tokenData);

  // Update store with refreshed tokens
  target.auth.accessToken = newAccessToken;
  target.auth.refreshToken = newRefreshToken;
  target.lastUsedAt = new Date().toISOString();
  writeStore(store);

  console.log(`Switched Kiro to [${idx}] ${target.displayName}.`);
  console.log('Restart Kiro IDE for the change to take effect.');
}

function findClientRegistration(clientIdHash) {
  if (!clientIdHash) return null;
  const filePath = path.join(SSO_CACHE_DIR, `${clientIdHash}.json`);
  return readJson(filePath);
}

function refreshOidcToken(refreshToken, clientId, clientSecret, region) {
  return new Promise((resolve) => {
    const url = `https://oidc.${region}.amazonaws.com/token`;
    const payload = JSON.stringify({ clientId, clientSecret, refreshToken, grantType: 'refresh_token' });

    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve({ success: true, accessToken: parsed.accessToken, refreshToken: parsed.refreshToken || refreshToken, expiresIn: parsed.expiresIn });
        } catch { resolve({ success: false, error: 'Parse error' }); }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    req.write(payload);
    req.end();
  });
}

function refreshSocialToken(refreshToken) {
  return new Promise((resolve) => {
    const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`;
    const payload = JSON.stringify({ refreshToken });

    const parsedUrl = new URL(url);
    const req = https.request({ hostname: parsedUrl.hostname, path: parsedUrl.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve({ success: true, accessToken: parsed.accessToken, refreshToken: parsed.refreshToken || refreshToken });
        } catch { resolve({ success: false, error: 'Parse error' }); }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    req.write(payload);
    req.end();
  });
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

async function runKiro(args) {
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
    await switchAccount(subcommand);
    return;
  }

  console.log(`Unknown kiro subcommand: ${subcommand}`);
  process.exitCode = 1;
}

module.exports = { runKiro, AUTH_PATH, CLI_AUTH_PATH, STORE_PATH };
