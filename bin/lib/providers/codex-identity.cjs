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
  const orgs = Array.isArray(authInfo.organizations) ? authInfo.organizations : [];
  return {
    email: payload.email || null,
    name: payload.name || null,
    userId: authInfo.chatgpt_user_id || null,
    accountId: auth.tokens.account_id || authInfo.chatgpt_account_id || null,
    planType: authInfo.chatgpt_plan_type || null,
    orgs,
    defaultOrg: orgs.find((org) => org?.is_default) || orgs[0] || null,
  };
}

function normalized(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function getCodexScopeKey(auth) {
  const info = extractAccountInfo(auth);
  const orgId = normalized(info?.defaultOrg?.id);
  return orgId ? `org:${orgId}` : null;
}

function getCodexOrgScopeKey(org) {
  const orgId = normalized(org?.id);
  return orgId ? `org:${orgId}` : null;
}

function withScope(baseKey, scope) {
  if (!baseKey) return null;
  return scope ? `${baseKey}:${scope}` : baseKey;
}

function getCodexAccountKey(auth) {
  const info = extractAccountInfo(auth);
  const scope = getCodexScopeKey(auth);
  const accountId = normalized(info?.accountId);
  if (accountId) return withScope(`account:${accountId}`, scope);
  const email = normalized(info?.email);
  if (email) return withScope(`email:${email}`, scope);
  if (auth?.OPENAI_API_KEY) return `key:${String(auth.OPENAI_API_KEY).slice(0, 12)}`;
  return null;
}

function getLegacyCodexAccountKey(auth) {
  const info = extractAccountInfo(auth);
  const accountId = normalized(info?.accountId);
  if (accountId) return `account:${accountId}`;
  const email = normalized(info?.email);
  if (email) return `email:${email}`;
  if (auth?.OPENAI_API_KEY) return `key:${String(auth.OPENAI_API_KEY).slice(0, 12)}`;
  return null;
}

function getCodexCredentialFingerprint(auth) {
  const tokens = auth?.tokens;
  const accessToken = normalized(tokens?.access_token) || '';
  const idToken = normalized(tokens?.id_token) || '';
  if (!accessToken && !idToken) return null;
  return JSON.stringify([accessToken, idToken]);
}

function getCodexGroupKey(entry) {
  const credential = getCodexCredentialFingerprint(entry?.auth);
  const scope = getCodexScopeKey(entry?.auth) || 'scope:none';
  return credential ? `${credential}:${scope}` : `entry:${entry?.key}`;
}

function getCodexDisplayName(auth, org) {
  const info = extractAccountInfo(auth);
  if (!info) return 'unknown';
  const displayOrg = org || info.defaultOrg;
  const parts = [];
  if (info.name) parts.push(info.name);
  if (info.email) parts.push(`<${info.email}>`);
  if (info.planType) parts.push(`(${info.planType})`);
  if (displayOrg?.title) parts.push(`[${displayOrg.title}]`);
  return parts.join(' ') || 'unknown';
}

function getCodexAccountGroups(store) {
  const groups = [];
  const groupsByKey = new Map();
  for (const [index, entry] of (store?.accounts || []).entries()) {
    const groupKey = getCodexGroupKey(entry);
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

function getDisplayCodexAccounts(store, currentAuth) {
  const currentKey = currentAuth ? getCodexAccountKey(currentAuth) : null;
  const currentCredential = getCodexCredentialFingerprint(currentAuth);
  const currentScope = getCodexScopeKey(currentAuth) || 'scope:none';

  return getCodexAccountGroups(store).flatMap((group) => {
    const currentGroupEntry = currentCredential
      ? group.entries.find(({ entry }) => {
          const credentialMatches = getCodexCredentialFingerprint(entry.auth) === currentCredential;
          const scopeMatches = (getCodexScopeKey(entry.auth) || 'scope:none') === currentScope;
          return credentialMatches && scopeMatches;
        })
      : null;
    const preferredEntry = currentGroupEntry
      || (currentKey ? group.entries.find(({ entry }) => entry.key === currentKey || getCodexAccountKey(entry.auth) === currentKey) : null)
      || group.entries[0];
    const info = extractAccountInfo(preferredEntry.entry.auth);
    const orgs = info?.orgs?.length ? info.orgs : [info?.defaultOrg].filter(Boolean);
    const baseDisplay = {
      ...preferredEntry.entry,
      index: preferredEntry.index,
      duplicateCount: group.entries.length,
    };

    if (!orgs.length) {
      return [{
        ...baseDisplay,
        current: currentCredential ? Boolean(currentGroupEntry) : Boolean(currentKey && preferredEntry.entry.key === currentKey),
      }];
    }

    return orgs.map((org) => {
      const scope = getCodexOrgScopeKey(org);
      const key = scope ? withScope(getLegacyCodexAccountKey(preferredEntry.entry.auth), scope) : preferredEntry.entry.key;
      const current = currentCredential
        ? Boolean(currentGroupEntry) && (scope || 'scope:none') === currentScope
        : Boolean(currentKey && key === currentKey);
      return {
        ...baseDisplay,
        key,
        displayName: getCodexDisplayName(preferredEntry.entry.auth, org),
        current,
        workspaceTitle: org?.title || null,
        workspaceId: org?.id || null,
        switchable: current,
      };
    });
  });
}

module.exports = {
  decodeJwtPayload,
  extractAccountInfo,
  getCodexAccountKey,
  getLegacyCodexAccountKey,
  getCodexCredentialFingerprint,
  getCodexOrgScopeKey,
  getCodexScopeKey,
  getDisplayCodexAccounts,
  getCodexDisplayName,
};
