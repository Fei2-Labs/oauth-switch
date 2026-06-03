const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/Windsurf - Next/User/globalStorage/state.vscdb'),
  path.join(os.homedir(), 'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'),
];

function readSQLiteValue(dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const output = execFileSync('/usr/bin/sqlite3', [
      dbPath,
      `select value from ItemTable where key='${key.replace(/'/g, "''")}' limit 1;`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return output || null;
  } catch (_) {
    return null;
  }
}

function readCachedPlanInfo(dbPath) {
  const json = readSQLiteValue(dbPath, 'windsurf.settings.cachedPlanInfo');
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function readLivePlanInfo(dbPath) {
  const json = readSQLiteValue(dbPath, 'windsurfAuthStatus');
  if (!json) return null;

  try {
    const auth = JSON.parse(json);
    const blob = Buffer.from(auth.userStatusProtoBinaryBase64 || '', 'base64');
    if (!blob.length) return null;
    return parseWindsurfUserStatus(blob);
  } catch (_) {
    return null;
  }
}

function loadWindsurfStatus() {
  for (const dbPath of STATE_PATHS) {
    const cachedPlanInfo = readCachedPlanInfo(dbPath);
    const livePlanInfo = readLivePlanInfo(dbPath);

    if (cachedPlanInfo || livePlanInfo) {
      return {
        sourcePath: dbPath,
        planInfo: mergePlanInfo(cachedPlanInfo, livePlanInfo),
      };
    }
  }
  return null;
}

function mergePlanInfo(cachedPlanInfo, livePlanInfo) {
  if (!cachedPlanInfo) return livePlanInfo;
  if (!livePlanInfo) return cachedPlanInfo;
  return {
    ...cachedPlanInfo,
    ...livePlanInfo,
    quotaUsage: mergeQuotaUsage(cachedPlanInfo.quotaUsage, livePlanInfo.quotaUsage),
    billingStrategy: cachedPlanInfo.billingStrategy || livePlanInfo.billingStrategy,
    usage: cachedPlanInfo.usage || livePlanInfo.usage,
  };
}

function mergeQuotaUsage(cachedQuotaUsage, liveQuotaUsage) {
  if (!cachedQuotaUsage) return liveQuotaUsage || null;
  if (!liveQuotaUsage) return cachedQuotaUsage;
  return {
    dailyRemainingPercent: liveQuotaUsage.dailyRemainingPercent ?? cachedQuotaUsage.dailyRemainingPercent ?? null,
    weeklyRemainingPercent: liveQuotaUsage.weeklyRemainingPercent ?? cachedQuotaUsage.weeklyRemainingPercent ?? null,
    overageBalanceMicros: liveQuotaUsage.overageBalanceMicros ?? cachedQuotaUsage.overageBalanceMicros ?? null,
    dailyResetAtUnix: liveQuotaUsage.dailyResetAtUnix ?? cachedQuotaUsage.dailyResetAtUnix ?? null,
    weeklyResetAtUnix: liveQuotaUsage.weeklyResetAtUnix ?? cachedQuotaUsage.weeklyResetAtUnix ?? null,
  };
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '?';
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatOptionalPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return formatPercent(value);
}

function formatCount(remaining, total) {
  if (typeof remaining !== 'number' || typeof total !== 'number') return '?';
  if (remaining < 0 || total < 0) return 'unlimited';
  return `${remaining}/${total}`;
}

function formatQuotaSummary(planInfo) {
  if (planInfo?.quotaUsage) {
    const parts = [];
    const daily = formatOptionalPercent(usagePercentFromRemaining(planInfo.quotaUsage.dailyRemainingPercent));
    const weekly = formatOptionalPercent(usagePercentFromRemaining(planInfo.quotaUsage.weeklyRemainingPercent));

    if (planInfo.hideDailyQuota !== true && daily) parts.push(`Daily usage ${daily}`);
    if (planInfo.hideWeeklyQuota !== true && weekly) parts.push(`Weekly usage ${weekly}`);
    if (parts.length > 0) return parts.join(' · ');
  }

  if (planInfo?.usage) {
    const messages = formatCount(planInfo.usage.remainingMessages, planInfo.usage.messages);
    const flow = formatCount(planInfo.usage.remainingFlowActions, planInfo.usage.flowActions);
    return `Messages ${messages} · Flow ${flow}`;
  }

  return 'No quota data';
}

function formatBadgePercent(planInfo, kind) {
  if (kind === 'daily' && typeof planInfo?.quotaUsage?.dailyRemainingPercent === 'number') {
    if (planInfo.hideDailyQuota === true) return null;
    return formatPercent(usagePercentFromRemaining(planInfo.quotaUsage.dailyRemainingPercent));
  }
  if (kind === 'weekly' && typeof planInfo?.quotaUsage?.weeklyRemainingPercent === 'number') {
    if (planInfo.hideWeeklyQuota === true) return null;
    return formatPercent(usagePercentFromRemaining(planInfo.quotaUsage.weeklyRemainingPercent));
  }
  if (planInfo?.quotaUsage) return null;
  if (kind === 'daily') {
    const usage = planInfo?.usage;
    return formatPercent(percentUsed(usage?.usedMessages, usage?.messages));
  }
  if (kind === 'weekly') {
    const usage = planInfo?.usage;
    return formatPercent(percentUsed(usage?.usedFlowActions, usage?.flowActions));
  }
  return '?';
}

function percentUsed(used, total) {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0 || used < 0) return null;
  return (used / total) * 100;
}

function usagePercentFromRemaining(remaining) {
  if (typeof remaining !== 'number' || Number.isNaN(remaining)) return null;
  return Math.max(0, Math.min(100, 100 - remaining));
}

function runWindsurf() {
  const status = loadWindsurfStatus();
  if (!status) {
    console.log('No Windsurf quota data found.');
    console.log('Expected local store: ~/Library/Application Support/Windsurf - Next/User/globalStorage/state.vscdb');
    return;
  }

  const { planInfo, sourcePath } = status;
  console.log('--- Windsurf ---');
  console.log(`Plan: ${planInfo.planName || 'Unknown'}`);
  console.log(`Quota: ${formatQuotaSummary(planInfo)}`);
  if (planInfo.quotaUsage) {
    const dailyUsage = formatBadgePercent(planInfo, 'daily');
    const weeklyUsage = formatBadgePercent(planInfo, 'weekly');
    if (dailyUsage) {
      console.log(`Daily usage: ${dailyUsage}`);
    }
    if (weeklyUsage) {
      console.log(`Weekly usage: ${weeklyUsage}`);
    }
    if (dailyUsage && typeof planInfo.quotaUsage.dailyResetAtUnix === 'number') {
      console.log(`Daily reset at: ${new Date(planInfo.quotaUsage.dailyResetAtUnix * 1000).toLocaleString()}`);
    }
    if (weeklyUsage && typeof planInfo.quotaUsage.weeklyResetAtUnix === 'number') {
      console.log(`Weekly reset at: ${new Date(planInfo.quotaUsage.weeklyResetAtUnix * 1000).toLocaleString()}`);
    }
  } else if (planInfo.usage) {
    console.log(`Messages remaining: ${formatCount(planInfo.usage.remainingMessages, planInfo.usage.messages)}`);
    console.log(`Flow actions remaining: ${formatCount(planInfo.usage.remainingFlowActions, planInfo.usage.flowActions)}`);
  }
  console.log(`Source: ${sourcePath}`);
}

function parseWindsurfUserStatus(buffer) {
  let offset = 0;
  let planStatus = null;

  while (offset < buffer.length) {
    const [tag, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (field === 13 && wireType === 2) {
      const [nested, afterNested] = readLengthDelimited(buffer, offset);
      offset = afterNested;
      planStatus = parseWindsurfPlanStatus(nested);
      break;
    }

    offset = skipWireField(buffer, offset, wireType);
  }

  if (!planStatus) return null;
  return {
    planName: planStatus.planName,
    startTimestamp: planStatus.startTimestamp,
    endTimestamp: planStatus.endTimestamp,
    usage: null,
    hasBillingWritePermissions: null,
    gracePeriodStatus: null,
    billingStrategy: null,
    quotaUsage: planStatus.quotaUsage,
    teamsTier: planStatus.teamsTier,
    hideDailyQuota: planStatus.hideDailyQuota,
    hideWeeklyQuota: planStatus.hideWeeklyQuota,
  };
}

function parseWindsurfPlanStatus(buffer) {
  let offset = 0;
  let planName = null;
  let startTimestamp = null;
  let endTimestamp = null;
  let dailyRemainingPercent = null;
  let weeklyRemainingPercent = null;
  let overageBalanceMicros = null;
  let dailyResetAtUnix = null;
  let weeklyResetAtUnix = null;
  let teamsTier = null;
  let hideDailyQuota = null;
  let hideWeeklyQuota = null;

  while (offset < buffer.length) {
    const [tag, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (field === 1 && wireType === 2) {
      const [planInfoBuffer, afterPlanInfo] = readLengthDelimited(buffer, offset);
      offset = afterPlanInfo;
      const parsed = parseWindsurfPlanInfo(planInfoBuffer);
      planName = parsed.planName ?? planName;
      teamsTier = parsed.teamsTier ?? teamsTier;
      hideDailyQuota = parsed.hideDailyQuota ?? hideDailyQuota;
      hideWeeklyQuota = parsed.hideWeeklyQuota ?? hideWeeklyQuota;
      continue;
    }

    if (field === 2 && wireType === 2) {
      const [timestampBuffer, afterTimestamp] = readLengthDelimited(buffer, offset);
      offset = afterTimestamp;
      startTimestamp = parseWindsurfTimestamp(timestampBuffer);
      continue;
    }

    if (field === 3 && wireType === 2) {
      const [timestampBuffer, afterTimestamp] = readLengthDelimited(buffer, offset);
      offset = afterTimestamp;
      endTimestamp = parseWindsurfTimestamp(timestampBuffer);
      continue;
    }

    if (field === 14 && wireType === 0) {
      [dailyRemainingPercent, offset] = readIntFromVarint(buffer, offset);
      continue;
    }
    if (field === 15 && wireType === 0) {
      [weeklyRemainingPercent, offset] = readIntFromVarint(buffer, offset);
      continue;
    }
    if (field === 16 && wireType === 0) {
      [overageBalanceMicros, offset] = readSignedInt64FromVarint(buffer, offset);
      continue;
    }
    if (field === 17 && wireType === 0) {
      [dailyResetAtUnix, offset] = readSignedInt64FromVarint(buffer, offset);
      continue;
    }
    if (field === 18 && wireType === 0) {
      [weeklyResetAtUnix, offset] = readSignedInt64FromVarint(buffer, offset);
      continue;
    }

    offset = skipWireField(buffer, offset, wireType);
  }

  const quotaUsage = (
    dailyRemainingPercent != null ||
    weeklyRemainingPercent != null ||
    overageBalanceMicros != null ||
    dailyResetAtUnix != null ||
    weeklyResetAtUnix != null
  ) ? {
    dailyRemainingPercent,
    weeklyRemainingPercent,
    overageBalanceMicros,
    dailyResetAtUnix,
    weeklyResetAtUnix,
  } : null;

  return {
    planName,
    startTimestamp,
    endTimestamp,
    quotaUsage,
    teamsTier,
    hideDailyQuota,
    hideWeeklyQuota,
  };
}

function parseWindsurfPlanInfo(buffer) {
  let offset = 0;
  let planName = null;
  let teamsTier = null;
  let hideDailyQuota = null;
  let hideWeeklyQuota = null;

  while (offset < buffer.length) {
    const [tag, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (field === 1 && wireType === 0) {
      [teamsTier, offset] = readIntFromVarint(buffer, offset);
      continue;
    }

    if (field === 2 && wireType === 2) {
      const [nameBuffer, afterName] = readLengthDelimited(buffer, offset);
      offset = afterName;
      planName = nameBuffer.toString('utf8');
      continue;
    }

    if (field === 36 && wireType === 0) {
      [hideDailyQuota, offset] = readBoolFromVarint(buffer, offset);
      continue;
    }

    if (field === 37 && wireType === 0) {
      [hideWeeklyQuota, offset] = readBoolFromVarint(buffer, offset);
      continue;
    }

    offset = skipWireField(buffer, offset, wireType);
  }

  return { planName, teamsTier, hideDailyQuota, hideWeeklyQuota };
}

function parseWindsurfTimestamp(buffer) {
  let offset = 0;
  let seconds = null;
  let nanos = null;

  while (offset < buffer.length) {
    const [tag, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (field === 1 && wireType === 0) {
      [seconds, offset] = readSignedInt64FromVarint(buffer, offset);
      continue;
    }

    if (field === 2 && wireType === 0) {
      [nanos, offset] = readSignedInt64FromVarint(buffer, offset);
      continue;
    }

    offset = skipWireField(buffer, offset, wireType);
  }

  if (seconds == null) return null;
  return Number(seconds) + Number(nanos || 0) / 1e9;
}

function readVarint(buffer, start) {
  let offset = start;
  let result = 0n;
  let shift = 0n;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, offset];
    }
    shift += 7n;
  }

  throw new Error('Invalid protobuf varint');
}

function readLengthDelimited(buffer, offset) {
  const [length, afterLength] = readVarint(buffer, offset);
  const end = afterLength + Number(length);
  return [buffer.subarray(afterLength, end), end];
}

function readIntFromVarint(buffer, offset) {
  const [value, after] = readVarint(buffer, offset);
  return [Number(value), after];
}

function readSignedInt64FromVarint(buffer, offset) {
  const [value, after] = readVarint(buffer, offset);
  const signed = BigInt.asIntN(64, value);
  return [Number(signed), after];
}

function readBoolFromVarint(buffer, offset) {
  const [value, after] = readVarint(buffer, offset);
  return [value !== 0n, after];
}

function skipWireField(buffer, offset, wireType) {
  switch (wireType) {
    case 0: {
      const [, after] = readVarint(buffer, offset);
      return after;
    }
    case 1:
      return offset + 8;
    case 2: {
      const [length, afterLength] = readVarint(buffer, offset);
      return afterLength + Number(length);
    }
    case 5:
      return offset + 4;
    default:
      throw new Error(`Unsupported wire type: ${wireType}`);
  }
}

module.exports = {
  loadWindsurfStatus,
  formatQuotaSummary,
  formatBadgePercent,
  runWindsurf,
};
