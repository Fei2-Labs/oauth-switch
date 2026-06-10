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
  const snapshot = {
    key,
    metadata: deepCopy(config.oauthAccount),
    credentials: deepCopy(credentials),
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
  normalizeStore,
  getDisplayAccounts,
  syncStoreFromLive,
  findSelection,
  removeStoredAccount,
  setStoredAccountDisabled,
};
