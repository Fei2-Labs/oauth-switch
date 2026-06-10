const fs = require('fs');
const os = require('os');
const path = require('path');

// Persistent switch history. Every line is `YYYY-MM-DD HH:mm:ss [source] message`
// (local time), where source is 'auto' (launchd daemon) or 'manual' (CLI / app).
const MAX_LOG_BYTES = 1024 * 1024; // ~1MB; trim when exceeded
const TRIM_KEEP_LINES = 500;

function getLogPath() {
  // Overridable for tests / sandboxed runs so they never touch the real file.
  return process.env.OAUTH_SWITCH_LOG_PATH
    || path.join(os.homedir(), '.oauth-switch', 'switch.log');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLine(source, message, date = new Date()) {
  const ts = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${ts} [${source}] ${message}`;
}

// Appends a timestamped line to the history file and returns the formatted
// line. Append failures are swallowed: logging must never crash a switch.
function logEvent(source, message, logPath = getLogPath()) {
  const line = formatLine(source, message);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      // File does not exist yet.
    }
    if (size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '');
      fs.writeFileSync(logPath, `${lines.slice(-TRIM_KEEP_LINES).join('\n')}\n`, 'utf8');
    }
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {
    // Never propagate logging errors to the caller.
  }
  return line;
}

// Returns the last `count` history lines, or null when no history exists.
function readRecentLines(count = 50, logPath = getLogPath()) {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return null;
    return lines.slice(-count);
  } catch {
    return null;
  }
}

module.exports = {
  MAX_LOG_BYTES,
  TRIM_KEEP_LINES,
  getLogPath,
  formatLine,
  logEvent,
  readRecentLines,
};
