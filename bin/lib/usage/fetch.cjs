const https = require('https');

function fetchUsage(accessToken, cache) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'claude-cli/claude-code-multi-accounts',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retrySecs = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          if (retrySecs) cache.setRateLimitResetAt(retrySecs);
          resolve({ rate_limited: true, retry_after: retrySecs });
          return;
        }
        if (res.statusCode !== 200) {
          const err = new Error(`Usage API returned ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed?.seven_day?.resets_at) {
            cache.setRateLimitResetAtFromIso(parsed.seven_day.resets_at);
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Failed to parse usage response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Usage API timeout'));
    });
  });
}

// Claude Code's public OAuth client id (same one the Claude Code CLI uses).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

function refreshOAuthToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    const req = https.request(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'claude-cli/claude-code-multi-accounts',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(`OAuth token refresh returned ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) {
            reject(new Error('OAuth token refresh response is missing access_token.'));
            return;
          }
          resolve({
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token || refreshToken,
            expiresAt: typeof parsed.expires_in === 'number'
              ? Date.now() + parsed.expires_in * 1000
              : undefined,
          });
        } catch {
          reject(new Error(`Failed to parse OAuth token refresh response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('OAuth token refresh timeout'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = { fetchUsage, refreshOAuthToken };
