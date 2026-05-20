const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

function getDefaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function getDefaultStorePath() {
  return path.join(os.homedir(), '.ClaudeCodeMultiAccounts.json');
}

function getDefaultBackupDir() {
  return path.join(os.homedir(), '.claude', 'backups', 'multi-account-switch');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCredentials(filePath) {
  // Try macOS Keychain first (Claude Code stores credentials there)
  try {
    const { execSync } = require('child_process');
    const json = execSync(
      `security find-generic-password -a "${process.env.USER || require('os').userInfo().username}" -s "Claude Code-credentials" -w`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
    if (json) return JSON.parse(json);
  } catch (_) {}
  // Fallback to file
  return readJson(filePath);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function backupFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) return;
  ensureDir(backupDir);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const base = path.basename(filePath);
  fs.copyFileSync(filePath, path.join(backupDir, `${base}.${timestamp}.bak`));

  const backups = fs.readdirSync(backupDir)
    .filter((name) => name.endsWith('.bak'))
    .sort()
    .reverse();

  for (const stale of backups.slice(3)) {
    fs.rmSync(path.join(backupDir, stale), { force: true });
  }
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeLiveState(config, credentials, options) {
  backupFile(options.configPath, options.backupDir);
  backupFile(options.credentialsPath, options.backupDir);
  writeJson(options.configPath, config);
  writeJson(options.credentialsPath, credentials);
}

function writeStore(store, options) {
  backupFile(options.storePath, options.backupDir);
  writeJson(options.storePath, store);
}

module.exports = {
  getDefaultConfigPath,
  getDefaultCredentialsPath,
  getDefaultStorePath,
  getDefaultBackupDir,
  ensureDir,
  readJson,
  readCredentials,
  readJsonIfExists,
  writeJson,
  backupFile,
  deepCopy,
  writeLiveState,
  writeStore,
};
