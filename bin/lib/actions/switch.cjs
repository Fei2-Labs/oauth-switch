const { logEvent } = require('../log.cjs');
const { clearAutoSwitchCooldown } = require('../store/state.cjs');
const {
  findClaudeAccountGroup,
  applyRefreshedCredentialsToGroup,
  setGroupCredentialStatus,
  getAccountKey,
} = require('../store/accounts.cjs');

// Pre-flight margin: snapshots whose accessToken expires within this window
// (or has already expired) are refreshed before they are written live.
const PREFLIGHT_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

// A definitively dead refresh token: the OAuth token endpoint rejected it with
// 400 invalid_grant / 401 / 403 / 404. These mark the credential group
// reauth_required. 5xx, network errors, timeouts (no statusCode) and 429
// throttling are transient and must NOT mark — the token may still be valid.
const REAUTH_STATUS_CODES = new Set([400, 401, 403, 404]);
function isAuthRejection(err) {
  return REAUTH_STATUS_CODES.has(err?.statusCode);
}

// True when the stored accessToken cannot be trusted for a live switch:
// expiresAt missing, unparseable, in the past, or within the safety margin.
function credentialNeedsRefresh(oauth, now = Date.now()) {
  const raw = oauth?.expiresAt;
  if (raw === undefined || raw === null) return true;
  const ms = typeof raw === 'number' ? raw : new Date(raw).getTime();
  if (Number.isNaN(ms)) return true;
  return ms <= now + PREFLIGHT_EXPIRY_MARGIN_MS;
}

// Verify (and if needed refresh) the target snapshot's OAuth credentials
// BEFORE they are written to the live config/Keychain. Stored refreshTokens
// rotate: other machines and Claude Code itself invalidate them, so a stale
// pool entry can hold revoked credentials that strand Claude Code on /login.
//
// Returns true when the store changed (refresh applied or group marked).
// Throws a printed, exit-worthy error when the target's credentials are dead.
async function ensureSwitchableCredentials({ selected, store, options, writeStore, refreshOAuthToken, now, currentKey }) {
  const oauth = selected?.credentials?.claudeAiOauth;
  // No OAuth credentials or no refreshToken: nothing we can verify or
  // refresh — switch as before (legacy entries).
  if (!oauth?.refreshToken) return false;
  // Switching to the account that is already live (switch-to-self): the live
  // config/Keychain already holds its authoritative credentials, so a stale
  // pool-copy refresh failure is not evidence the account is dead. Skip the
  // pre-flight refresh + dead-cred marking entirely.
  if (currentKey && selected?.key && selected.key === currentKey) return false;
  if (!credentialNeedsRefresh(oauth, now)) return false;

  const email = selected.metadata?.emailAddress || selected.key;
  const group = findClaudeAccountGroup(store, selected.key);
  let refreshed;
  try {
    refreshed = await refreshOAuthToken(oauth.refreshToken);
  } catch (err) {
    const rejected = isAuthRejection(err);
    const line = rejected
      ? `Cannot switch: credentials for ${email} are no longer valid. Log in with this account in Claude Code once to refresh them.`
      : `Cannot switch: could not verify credentials for ${email} (${err.message}). Try again.`;
    // The macOS app footer surfaces the first meaningful output line: print
    // the explanation before anything else.
    console.log(line);
    if (rejected && group) {
      // Token endpoint rejected the refreshToken: the whole credential group
      // is dead until the user logs in again. Persist the marker so list/UI
      // can show it and auto-switch skips the group.
      setGroupCredentialStatus(store, group, 'reauth_required', new Date(now).toISOString());
      writeStore(store, options);
    }
    logEvent('manual', `Blocked switch to ${email}: OAuth token refresh failed (${err.message})`);
    const blocked = new Error(line);
    blocked.code = 'SWITCH_BLOCKED_REAUTH';
    blocked.printed = true;
    throw blocked;
  }

  if (group) {
    applyRefreshedCredentialsToGroup(store, group, refreshed);
  } else {
    oauth.accessToken = refreshed.accessToken;
    if (refreshed.refreshToken) oauth.refreshToken = refreshed.refreshToken;
    if (refreshed.expiresAt) oauth.expiresAt = refreshed.expiresAt;
  }
  return true;
}

async function runSwitchAction(context) {
  const {
    selected,
    store,
    config,
    options,
    deepCopy,
    writeLiveState,
    writeStore,
    getDisplayAccounts,
    inferPlanType,
    getPreferredDisplayName,
    getRestartNotice,
    getStoredAccountsHeading,
    formatAccountSummary,
    RESET_WINDOW_DAYS,
    getRateLimitResetAt,
    refreshOAuthToken = require('../usage/fetch.cjs').refreshOAuthToken,
  } = context;

  // Pre-flight: never write expired/revoked credentials to the live state.
  await ensureSwitchableCredentials({
    selected,
    store,
    options,
    writeStore,
    refreshOAuthToken,
    now: context.now ?? Date.now(),
    currentKey: config?.oauthAccount ? getAccountKey(config.oauthAccount) : null,
  });

  const now = new Date().toISOString();
  const storeIndex = store.accounts.findIndex((e) => e.key === selected.key);
  if (storeIndex >= 0) {
    store.accounts[storeIndex].lastUsedAt = now;
  }
  const nextConfig = deepCopy(config);
  // Use the STORE entry's credentials: the pre-flight may have just written
  // fresh tokens there, while `selected` can hold a pre-refresh copy.
  const sourceCredentials = storeIndex >= 0
    ? store.accounts[storeIndex].credentials
    : selected.credentials;
  const nextCredentials = deepCopy(sourceCredentials);
  nextConfig.oauthAccount = deepCopy(selected.metadata);

  writeLiveState(nextConfig, nextCredentials, options);
  writeStore(store, options);

  logEvent('manual', `Switched Claude to ${getPreferredDisplayName(selected.metadata)} <${selected.metadata.emailAddress}>`);
  // Manual switches express user intent: reset the auto-switch cooldown.
  clearAutoSwitchCooldown('claude');

  const currentAccounts = getDisplayAccounts(store, selected.metadata, nextCredentials);
  const currentPlan = inferPlanType(selected);
  console.log(`Switched active account to [${selected.index}] ${getPreferredDisplayName(selected.metadata)} <${selected.metadata.emailAddress}> (${currentPlan}).`);
  console.log('');
  console.log(getRestartNotice());
  console.log('');
  console.log(getStoredAccountsHeading());
  for (const line of formatAccountSummary(currentAccounts)) {
    console.log(line);
  }
}

module.exports = { runSwitchAction, credentialNeedsRefresh, PREFLIGHT_EXPIRY_MARGIN_MS };
