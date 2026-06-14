function getAccountKey(account) {
  const scope = getClaudeAccountScopeKey(account);
  if (account?.accountUuid && String(account.accountUuid).trim()) {
    return withScope(`uuid:${String(account.accountUuid).trim().toLowerCase()}`, scope);
  }
  if (account?.emailAddress && String(account.emailAddress).trim()) {
    return withScope(`email:${String(account.emailAddress).trim().toLowerCase()}`, scope);
  }
  throw new Error('Account entry is missing both accountUuid and emailAddress.');
}

function getLegacyAccountKey(account) {
  if (account?.accountUuid && String(account.accountUuid).trim()) {
    return `uuid:${String(account.accountUuid).trim().toLowerCase()}`;
  }
  if (account?.emailAddress && String(account.emailAddress).trim()) {
    return `email:${String(account.emailAddress).trim().toLowerCase()}`;
  }
  return null;
}

function withScope(baseKey, scope) {
  return scope ? `${baseKey}:${scope}` : baseKey;
}

function getClaudeAccountScopeKey(account) {
  const workspaceUuid = account?.workspaceUuid || account?.workspaceId;
  if (workspaceUuid && String(workspaceUuid).trim()) {
    return `workspace:${String(workspaceUuid).trim().toLowerCase()}`;
  }

  const organizationUuid = account?.organizationUuid || account?.organizationId;
  if (organizationUuid && String(organizationUuid).trim()) {
    return `org:${String(organizationUuid).trim().toLowerCase()}`;
  }

  return null;
}

function normalizeCredentialValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getClaudeCredentialFingerprint(credentials) {
  const claude = credentials?.claudeAiOauth;
  if (!claude || typeof claude !== 'object') return null;

  const accessToken = normalizeCredentialValue(claude.accessToken);
  const refreshToken = normalizeCredentialValue(claude.refreshToken);
  if (!accessToken && !refreshToken) return null;

  return JSON.stringify([accessToken, refreshToken]);
}

function getClaudeAccountGroupKey(entry) {
  const credential = getClaudeCredentialFingerprint(entry?.credentials);
  const scope = getClaudeAccountScopeKey(entry?.metadata) || 'scope:none';
  return credential ? `${credential}:${scope}` : `entry:${entry?.key}`;
}

function normalizeStore(store, storeVersion) {
  const normalized = store && typeof store === 'object' ? store : {};
  if (!Array.isArray(normalized.accounts)) {
    normalized.accounts = [];
  }
  normalized.version = storeVersion;
  return normalized;
}

function getClaudeAccountGroups(store) {
  const groups = [];
  const groupsByKey = new Map();

  for (const [index, entry] of (store?.accounts || []).entries()) {
    const groupKey = getClaudeAccountGroupKey(entry);
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = { key: groupKey, entries: [] };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }
    group.entries.push({ entry, index });
  }

  return groups;
}

// Find the credential group (see getClaudeAccountGroups) that contains the
// store entry with the given key. Returns null when the key is unknown.
function findClaudeAccountGroup(store, key) {
  return getClaudeAccountGroups(store).find((group) =>
    group.entries.some(({ entry }) => entry.key === key)
  ) || null;
}

// Apply a successful OAuth refresh to every store entry in a credential
// group. Also clears any reauth marker: a successful refresh proves the
// credentials are alive again. Returns true when anything changed.
function applyRefreshedCredentialsToGroup(store, group, refreshed) {
  let changed = false;
  for (const { index } of group.entries) {
    const entry = store.accounts[index];
    const oauth = entry?.credentials?.claudeAiOauth;
    if (!oauth) continue;
    oauth.accessToken = refreshed.accessToken;
    if (refreshed.refreshToken) oauth.refreshToken = refreshed.refreshToken;
    if (refreshed.expiresAt) oauth.expiresAt = refreshed.expiresAt;
    delete entry.credentialStatus;
    delete entry.credentialCheckedAt;
    changed = true;
  }
  return changed;
}

// Mark every entry in a credential group as needing a manual re-login
// (refreshToken rejected by the OAuth token endpoint with a 4xx).
function setGroupCredentialStatus(store, group, status, checkedAt) {
  let changed = false;
  for (const { index } of group.entries) {
    const entry = store.accounts[index];
    if (!entry) continue;
    if (entry.credentialStatus !== status || entry.credentialCheckedAt !== checkedAt) changed = true;
    entry.credentialStatus = status;
    entry.credentialCheckedAt = checkedAt;
  }
  return changed;
}

function clearGroupCredentialStatus(store, group) {
  let changed = false;
  for (const { index } of group.entries) {
    const entry = store.accounts[index];
    if (!entry) continue;
    if (entry.credentialStatus !== undefined || entry.credentialCheckedAt !== undefined) {
      delete entry.credentialStatus;
      delete entry.credentialCheckedAt;
      changed = true;
    }
  }
  return changed;
}

function getDisplayAccounts(store, currentMetadata, currentCredentials) {
  const currentKey = currentMetadata ? getAccountKey(currentMetadata) : null;
  const currentCredentialKey = getClaudeCredentialFingerprint(currentCredentials);
  const currentScope = getClaudeAccountScopeKey(currentMetadata) || 'scope:none';

  return getClaudeAccountGroups(store).map((group) => {
    const currentGroupEntry = currentCredentialKey
      ? group.entries.find(({ entry }) => {
          const credentialMatches = getClaudeCredentialFingerprint(entry.credentials) === currentCredentialKey;
          const scopeMatches = (getClaudeAccountScopeKey(entry.metadata) || 'scope:none') === currentScope;
          return credentialMatches && scopeMatches;
        })
      : null;
    const preferredEntry = currentGroupEntry
      || (currentKey ? group.entries.find(({ entry }) => getAccountKey(entry.metadata) === currentKey) : null)
      || group.entries[0];
    const current = currentCredentialKey
      ? Boolean(currentGroupEntry)
      : (currentKey ? getAccountKey(preferredEntry.entry.metadata) === currentKey : false);

    return {
      ...preferredEntry.entry,
      index: preferredEntry.index,
      current,
      duplicateCount: group.entries.length,
    };
  });
}

function syncStoreFromLive(store, config, credentials, deepCopy, storeVersion) {
  if (!config?.oauthAccount) {
    throw new Error('The Claude config does not contain oauthAccount.');
  }
  if (!credentials?.claudeAiOauth) {
    throw new Error('The Claude credentials file does not contain claudeAiOauth.');
  }

  const key = getAccountKey(config.oauthAccount);
  const legacyKey = getLegacyAccountKey(config.oauthAccount);
  const now = new Date().toISOString();
  const existingEntry = store.accounts?.find((e) => e.key === key)
    || (legacyKey ? store.accounts?.find((e) => e.key === legacyKey) : null);

  // Guard against capturing a degraded credential. Claude Code rotates tokens
  // by writing a fresh accessToken to the Keychain, and during that window the
  // entry can transiently lack a refreshToken. Overwriting our stored snapshot
  // with that refreshToken-less credential turns a healthy account into a dead
  // "re-login required" one. When the live credential has no refreshToken but
  // the existing stored entry does, keep the stored refreshToken while taking
  // the fresh accessToken/expiresAt.
  const capturedCredentials = deepCopy(credentials);
  const liveOauth = capturedCredentials.claudeAiOauth;
  const existingOauth = existingEntry?.credentials?.claudeAiOauth;
  const liveHasRefresh = Boolean(normalizeCredentialValue(liveOauth?.refreshToken));
  const existingHasRefresh = Boolean(normalizeCredentialValue(existingOauth?.refreshToken));
  if (liveOauth && !liveHasRefresh && existingHasRefresh) {
    console.error(
      `[oauth-switch] Live credential for ${key} is missing a refreshToken; preserving the stored refreshToken (likely a transient Keychain state during token rotation).`
    );
    liveOauth.refreshToken = existingOauth.refreshToken;
  }

  const snapshot = {
    key,
    metadata: deepCopy(config.oauthAccount),
    credentials: capturedCredentials,
    capturedAt: now,
    lastSyncedAt: now,
    lastUsedAt: existingEntry?.lastUsedAt || undefined,
    usageSnapshot: existingEntry?.usageSnapshot || undefined,
    disabled: existingEntry?.disabled || undefined,
  };

  const nextStore = normalizeStore(deepCopy(store), storeVersion);
  let existingIndex = nextStore.accounts.findIndex((entry) => entry.key === key);
  if (existingIndex < 0 && legacyKey) {
    existingIndex = nextStore.accounts.findIndex((entry) => entry.key === legacyKey);
  }
  if (existingIndex >= 0) {
    nextStore.accounts[existingIndex] = snapshot;
  } else {
    nextStore.accounts.push(snapshot);
  }

  nextStore.updatedAt = new Date().toISOString();

  return {
    changed: JSON.stringify(store) !== JSON.stringify(nextStore),
    store: nextStore,
    key,
  };
}

function findSelection(accounts, selector) {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error('Selector cannot be empty.');
  }

  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(numeric) && String(numeric) === trimmed) {
    const byIndex = accounts.find((entry) => Number(entry.index) === numeric);
    if (byIndex) return byIndex;
  }

  throw new Error(`No account matched index '${trimmed}'. Use a numeric index.`);
}

function removeStoredAccount(store, removeIndex) {
  if (typeof removeIndex !== 'number' || removeIndex < 0 || removeIndex >= store.accounts.length) {
    throw new Error(`Invalid account index. Use an index between 0 and ${store.accounts.length - 1}.`);
  }
  const removed = store.accounts.splice(removeIndex, 1)[0];
  store.accounts.forEach((entry, i) => {
    entry.index = i;
  });
  return removed;
}

function setStoredAccountDisabled(store, accountIndex, disabled) {
  if (typeof accountIndex !== 'number' || accountIndex < 0 || accountIndex >= store.accounts.length) {
    throw new Error(`Invalid account index. Use an index between 0 and ${store.accounts.length - 1}.`);
  }
  if (disabled) {
    store.accounts[accountIndex].disabled = true;
  } else {
    delete store.accounts[accountIndex].disabled;
  }
  return store.accounts[accountIndex];
}

module.exports = {
  getAccountKey,
  getClaudeCredentialFingerprint,
  getClaudeAccountGroups,
  getClaudeAccountScopeKey,
  findClaudeAccountGroup,
  applyRefreshedCredentialsToGroup,
  setGroupCredentialStatus,
  clearGroupCredentialStatus,
  normalizeStore,
  getDisplayAccounts,
  syncStoreFromLive,
  findSelection,
  removeStoredAccount,
  setStoredAccountDisabled,
};
