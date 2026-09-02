/**
 * services/local-sync/http/endpoints/preview-summary-endpoint.js
 * Pre-sync diff computation for the web companion's "currently synced
 * vs pending" preview. Pure projection over (accounts × deltaBuckets)
 * - no DB writes - so the user can preview the impact before clicking
 * Apply. Mirrors `summarizeRaidProgress` from utils/raid/common so the
 * percent matches what /raid-status shows post-sync.
 */

"use strict";

const {
  COMPANION_SCOPE,
  bucketizeLocalSyncDeltas,
  isModeAllowedForCompanionScope,
  normalizeLocalSyncDifficulty,
} = require("../..");
const {
  createJsonSender,
} = require("../json");
const {
  requireCurrentLocalSyncUser,
} = require("../request-gates");
const { readAuthenticatedPreviewRequest } = require("./preview-request");
const {
  RAID_REQUIREMENTS,
  getGatesForRaid,
  getGoldForGate,
  getBoundGoldForGate,
  isGoldBound,
} = require("../../../../domain/raid-catalog");
const { normalizeName, toModeLabel } = require("../../../../utils/raid/common/shared");
const {
  getGoldOverride,
  getStatusRaidsForCharacter,
} = require("../../../../utils/raid/common/character");
const { getCurrentResetStartMs } = require("../../../raid/schedulers/weekly-reset");
const {
  buildRosterCharacterIndex,
  classifyBucketAgainstRoster,
  isCurrentWeekCompletion,
  resolveBucketModePreference,
} = require("../../core/apply/apply-roster");

const RAID_KEYS = Object.keys(RAID_REQUIREMENTS);
const RAID_ORDER_INDEX = new Map(RAID_KEYS.map((raidKey, index) => [raidKey, index]));

function bucketizeCurrentWeekDeltas(deltas, currentWeekStartMs = 0) {
  const weekStartMs = Number(currentWeekStartMs) || 0;
  return bucketizeLocalSyncDeltas((deltas || []).filter((delta) => (
    Number(delta?.lastClearMs) >= weekStartMs
  )));
}

function makeGateKey(raidKey, modeKey, gate) {
  return `${raidKey}::${modeKey}::${gate}`;
}

function cloneRaidStates(raidStates) {
  const cloned = new Map();
  for (const [raidKey, state] of raidStates.entries()) {
    cloned.set(raidKey, {
      modeKey: state.modeKey,
      cleared: new Map(state.cleared),
    });
  }
  return cloned;
}

function buildSimulatedAssignedRaids(char, finalRaidStates) {
  const assignedRaids = { ...(char?.assignedRaids || {}) };
  for (const [raidKey, state] of finalRaidStates.entries()) {
    const source = char?.assignedRaids?.[raidKey] || {};
    const modeLabel = toModeLabel(state.modeKey);
    const raidData = { modeKey: state.modeKey };
    const goldOverride = getGoldOverride(source);
    if (goldOverride) raidData.goldOverride = goldOverride;
    for (const gate of getGatesForRaid(raidKey)) {
      raidData[gate] = {
        difficulty: modeLabel,
        completedDate: state.cleared.get(gate) || null,
      };
    }
    assignedRaids[raidKey] = raidData;
  }
  return assignedRaids;
}

function indexBucketsByCharacter(deltaBuckets, scope) {
  const bucketsByCharLower = new Map();
  for (const bucket of deltaBuckets || []) {
    if (!isModeAllowedForCompanionScope(scope, bucket?.modeKey)) continue;
    const key = normalizeName(bucket.charName);
    if (!key) continue;
    if (!bucketsByCharLower.has(key)) bucketsByCharLower.set(key, []);
    bucketsByCharLower.get(key).push(bucket);
  }
  return bucketsByCharLower;
}

function raidSupportsPreviewScope(raidKey, scope) {
  if (scope !== COMPANION_SCOPE.solo) return true;
  return Boolean(RAID_REQUIREMENTS[raidKey]?.modes?.solo);
}

function resolvePreviewModeKey(raid, scope) {
  return scope === COMPANION_SCOPE.solo
    ? COMPANION_SCOPE.solo
    : raid.modeKey;
}

function resolveStoredModeKey(assignedRaid, raidKey) {
  const gateDifficulty = getGatesForRaid(raidKey)
    .map((gate) => assignedRaid?.[gate]?.difficulty)
    .find(Boolean);
  return normalizeLocalSyncDifficulty(assignedRaid.modeKey || gateDifficulty);
}

function getPreSyncCompletedGateKeys(raid, scope, storedModeKey) {
  if (scope === COMPANION_SCOPE.solo && storedModeKey !== COMPANION_SCOPE.solo) {
    return [];
  }
  return raid.completedGateKeys || [];
}

function resolveGateCompletedAt(assignedRaid, raid, gate) {
  return Number(assignedRaid?.[gate]?.completedDate)
    || Number(raid.completedAt)
    || 0;
}

function buildPreSyncRaidStates(char, { scope, currentWeekStartMs }) {
  const dbClearedGates = new Map();
  const preRaidStates = new Map();

  for (const raid of getStatusRaidsForCharacter(char)) {
    if (!raidSupportsPreviewScope(raid.raidKey, scope)) continue;
    const modeKey = resolvePreviewModeKey(raid, scope);
    const state = { modeKey, cleared: new Map() };
    const assignedRaid = char?.assignedRaids?.[raid.raidKey] || {};
    const storedModeKey = resolveStoredModeKey(assignedRaid, raid.raidKey);
    const completedGateKeys = getPreSyncCompletedGateKeys(raid, scope, storedModeKey);
    for (const gate of completedGateKeys) {
      const completedAt = resolveGateCompletedAt(assignedRaid, raid, gate);
      if (!isCurrentWeekCompletion(completedAt, currentWeekStartMs)) continue;
      state.cleared.set(gate, completedAt);
      dbClearedGates.set(makeGateKey(raid.raidKey, modeKey, gate), true);
    }
    preRaidStates.set(raid.raidKey, state);
  }

  return { dbClearedGates, preRaidStates };
}

function applyPreviewBuckets({
  charBuckets,
  rosterDoc,
  rosterIndex,
  preRaidStates,
  dbClearedGates,
  scope,
  currentWeekStartMs,
}) {
  const finalRaidStates = cloneRaidStates(preRaidStates);
  const appliedGates = new Map();

  for (const incomingBucket of charBuckets) {
    if (Number(incomingBucket.lastClearMs) < currentWeekStartMs) continue;
    const bucket = resolveBucketModePreference(rosterDoc, incomingBucket, { rosterIndex });
    if (!RAID_REQUIREMENTS[bucket.raidKey]?.modes?.[bucket.modeKey]) continue;
    const gates = getGatesForRaid(bucket.raidKey);
    const effectiveGates = gates.slice(0, bucket.gateIndex + 1);
    const modeRequirement = RAID_REQUIREMENTS[bucket.raidKey].modes[bucket.modeKey];
    const preflight = classifyBucketAgainstRoster(
      rosterDoc,
      bucket,
      { minItemLevel: modeRequirement.minItemLevel },
      effectiveGates,
      { currentWeekStartMs, requiredCompanionScope: scope, rosterIndex }
    );
    if (preflight.action !== "apply") continue;

    let state = finalRaidStates.get(bucket.raidKey);
    if (!state || state.modeKey !== bucket.modeKey) {
      state = { modeKey: bucket.modeKey, cleared: new Map() };
      finalRaidStates.set(bucket.raidKey, state);
    }
    for (let index = 0; index <= bucket.gateIndex && index < gates.length; index += 1) {
      const gate = gates[index];
      const dbKey = makeGateKey(bucket.raidKey, bucket.modeKey, gate);
      if (!dbClearedGates.has(dbKey)) {
        appliedGates.set(dbKey, { raidKey: bucket.raidKey, modeKey: bucket.modeKey, gate });
      }
      state.cleared.set(gate, Number(bucket.lastClearMs) || Date.now());
    }
  }

  return { finalRaidStates, appliedGates };
}

function summarizeAppliedGates({ account, char, appliedGates, finalRaidEntriesByKey }) {
  let gold = 0;
  let goldBound = 0;
  const changedRaidKeys = new Set();

  for (const { raidKey, modeKey, gate } of appliedGates.values()) {
    changedRaidKeys.add(`${normalizeName(char.name)}::${raidKey}::${modeKey}`);
    const finalRaid = finalRaidEntriesByKey.get(raidKey);
    if (char.isGoldEarner === false || !finalRaid?.goldReceives) continue;
    const bound = getBoundGoldForGate(raidKey, modeKey, gate);
    const unbound = isGoldBound(raidKey, modeKey)
      ? 0
      : getGoldForGate(raidKey, modeKey, gate);
    gold += unbound + bound;
    goldBound += bound;
  }

  return {
    changedRaidKeys,
    gold,
    goldBound,
    goldRecord: gold > 0 ? {
      accountName: account?.accountName || "",
      charName: char.name || "",
      className: char.class || "",
      itemLevel: Number(char.itemLevel) || 0,
      gold,
      goldBound,
    } : null,
  };
}

function buildChangeDetail(account, char, appliedGates) {
  if (appliedGates.size === 0) return null;
  const raidsByMode = new Map();
  for (const { raidKey, modeKey, gate } of appliedGates.values()) {
    const detailKey = `${raidKey}::${modeKey}`;
    if (!raidsByMode.has(detailKey)) {
      raidsByMode.set(detailKey, { raidKey, modeKey, gates: [] });
    }
    const detail = raidsByMode.get(detailKey);
    if (!detail.gates.includes(gate)) detail.gates.push(gate);
  }
  for (const detail of raidsByMode.values()) {
    const canonicalGates = getGatesForRaid(detail.raidKey);
    detail.gates.sort((a, b) => canonicalGates.indexOf(a) - canonicalGates.indexOf(b));
  }
  return {
    accountName: account?.accountName || "",
    charName: char.name || "",
    className: char.class || "",
    itemLevel: Number(char.itemLevel) || 0,
    raids: [...raidsByMode.values()].sort(
      (a, b) => RAID_ORDER_INDEX.get(a.raidKey) - RAID_ORDER_INDEX.get(b.raidKey)
    ),
  };
}

function countCompletedRaids(raidStates) {
  let completed = 0;
  for (const [raidKey, state] of raidStates.entries()) {
    if (state.cleared.size === getGatesForRaid(raidKey).length) completed += 1;
  }
  return completed;
}

function buildFinalRaidProjection(finalRaidStates, appliedGates) {
  const incomingRaidModes = new Set(
    [...appliedGates.values()].map(({ raidKey, modeKey }) => `${raidKey}::${modeKey}`)
  );
  const raids = [];
  let projectedCleared = 0;

  for (const raidKey of RAID_KEYS) {
    const state = finalRaidStates.get(raidKey);
    if (!state) continue;
    const gates = getGatesForRaid(raidKey);
    let status = "pending";
    if (state.cleared.size === gates.length) {
      projectedCleared += 1;
      status = "done";
    } else if (state.cleared.size > 0) {
      status = "partial";
    }
    raids.push({
      raidKey,
      modeKey: state.modeKey,
      status,
      incoming: incomingRaidModes.has(`${raidKey}::${state.modeKey}`),
    });
  }

  return { raids, total: raids.length, projectedCleared };
}

function projectCharacter({
  account,
  char,
  charBuckets,
  rosterDoc,
  rosterIndex,
  scope,
  currentWeekStartMs,
}) {
  const { dbClearedGates, preRaidStates } = buildPreSyncRaidStates(char, {
    scope,
    currentWeekStartMs,
  });
  const { finalRaidStates, appliedGates } = applyPreviewBuckets({
    charBuckets,
    rosterDoc,
    rosterIndex,
    preRaidStates,
    dbClearedGates,
    scope,
    currentWeekStartMs,
  });
  const simulatedChar = {
    ...char,
    assignedRaids: buildSimulatedAssignedRaids(char, finalRaidStates),
  };
  const finalRaidEntriesByKey = new Map(
    getStatusRaidsForCharacter(simulatedChar).map((raid) => [raid.raidKey, raid])
  );
  const applied = summarizeAppliedGates({
    account,
    char,
    appliedGates,
    finalRaidEntriesByKey,
  });
  const finalProjection = buildFinalRaidProjection(finalRaidStates, appliedGates);
  const hasRaidProjection = finalProjection.raids.length > 0;

  return {
    appliedGates,
    changedRaidKeys: applied.changedRaidKeys,
    gold: applied.gold,
    goldBound: applied.goldBound,
    goldRecord: applied.goldRecord,
    changeDetail: buildChangeDetail(account, char, appliedGates),
    clearedRaids: countCompletedRaids(preRaidStates),
    totalRaids: finalProjection.total,
    projectedClearedRaids: finalProjection.projectedCleared,
    charAfterSync: hasRaidProjection ? {
      accountName: account?.accountName || "",
      charName: char.name || "",
      className: char.class || "",
      itemLevel: Number(char.itemLevel) || 0,
      raids: finalProjection.raids,
    } : null,
    simulatedChar: hasRaidProjection ? simulatedChar : null,
  };
}

function createProjectionAccumulator() {
  return {
    goldByChar: new Map(),
    goldTotal: 0,
    goldBoundTotal: 0,
    totalRaids: 0,
    clearedRaids: 0,
    projectedClearedRaids: 0,
    changedGateCount: 0,
    changedChars: new Set(),
    changedRaids: new Set(),
    changeDetails: [],
    charsAfterSync: [],
    accountsAfterSync: [],
  };
}

function accumulateCharacterProjection(
  summary,
  { char, charNameLower, projection, simulatedChars }
) {
  summary.changedGateCount += projection.appliedGates.size;
  if (projection.appliedGates.size > 0) summary.changedChars.add(charNameLower);
  for (const raidKey of projection.changedRaidKeys) summary.changedRaids.add(raidKey);
  summary.goldTotal += projection.gold;
  summary.goldBoundTotal += projection.goldBound;
  if (projection.goldRecord) summary.goldByChar.set(char.name, projection.goldRecord);
  if (projection.changeDetail) summary.changeDetails.push(projection.changeDetail);
  summary.clearedRaids += projection.clearedRaids;
  summary.totalRaids += projection.totalRaids;
  summary.projectedClearedRaids += projection.projectedClearedRaids;
  if (projection.charAfterSync) summary.charsAfterSync.push(projection.charAfterSync);
  if (projection.simulatedChar) simulatedChars.push(projection.simulatedChar);
}

function projectAccountSummary({
  account,
  bucketsByCharLower,
  rosterDoc,
  rosterIndex,
  scope,
  currentWeekStartMs,
  summary,
}) {
  const simulatedChars = [];
  for (const char of account.characters || []) {
    const charNameLower = normalizeName(char.name);
    const projection = projectCharacter({
      account,
      char,
      charBuckets: bucketsByCharLower.get(charNameLower) || [],
      rosterDoc,
      rosterIndex,
      scope,
      currentWeekStartMs,
    });
    accumulateCharacterProjection(summary, {
      char,
      charNameLower,
      projection,
      simulatedChars,
    });
  }
  return simulatedChars.length > 0
    ? { ...account, characters: simulatedChars }
    : null;
}

function calculateCompletionPercent(completed, total) {
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

function buildProjectionResponse(summary) {
  return {
    changes: {
      chars: summary.changedChars.size,
      raids: summary.changedRaids.size,
      gates: summary.changedGateCount,
    },
    changeDetails: summary.changeDetails,
    goldDelta: {
      total: summary.goldTotal,
      boundTotal: summary.goldBoundTotal,
      byChar: [...summary.goldByChar.values()].sort((a, b) => b.gold - a.gold),
    },
    completion: {
      totalRaids: summary.totalRaids,
      cleared: summary.clearedRaids,
      projected: summary.projectedClearedRaids,
      percent: calculateCompletionPercent(summary.clearedRaids, summary.totalRaids),
      projectedPercent: calculateCompletionPercent(
        summary.projectedClearedRaids,
        summary.totalRaids
      ),
    },
    charsAfterSync: summary.charsAfterSync,
    accountsAfterSync: summary.accountsAfterSync,
  };
}

/**
 * Walk the user's accounts + characters and compute the four projections.
 * Pure function over (accounts, deltaBuckets) - no DB writes, no async.
 */
function projectSummary(
  accounts,
  deltaBuckets,
  { scope = COMPANION_SCOPE.full, currentWeekStartMs = 0 } = {}
) {
  const rosterDoc = { accounts };
  const rosterIndex = buildRosterCharacterIndex(rosterDoc);
  const bucketsByCharLower = indexBucketsByCharacter(deltaBuckets, scope);
  const summary = createProjectionAccumulator();

  for (const account of accounts || []) {
    const simulatedAccount = projectAccountSummary({
      account,
      bucketsByCharLower,
      rosterDoc,
      rosterIndex,
      scope,
      currentWeekStartMs,
      summary,
    });
    if (simulatedAccount) summary.accountsAfterSync.push(simulatedAccount);
  }
  return buildProjectionResponse(summary);
}

/**
 * Build the `POST /api/local-sync/preview-summary` handler. Pre-sync
 * companion stats: gold delta, completion projection, raid status list,
 * last-sync timestamps. Lets the user preview post-sync changes before
 * clicking the Sync button.
 *
 * Auth chain mirrors the sync endpoint - Bearer JWT, verify, Mongo state
 * check (localSyncEnabled, isCurrentStoredToken). Pure read; no writes.
 */
function createPreviewSummaryEndpoint({ User }) {
  if (!User) throw new Error("[preview-summary] User model required");

  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handlePreviewSummary(req, res) {
    const request = await readAuthenticatedPreviewRequest({ req, res, send });
    if (!request) return;
    const { token, discordId, payload, scope, scopeExplicit, body } = request;

    const deltas = Array.isArray(body?.deltas) ? body.deltas : [];

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select("autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt lastLocalSyncAt lastAutoManageSyncAt accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.isGoldEarner accounts.characters.assignedRaids")
        .lean();
    } catch (err) {
      console.error("[preview-summary] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }

    if (!userDoc) {
      send(res, 200, {
        ok: true,
        scope,
        goldDelta: { total: 0, boundTotal: 0, byChar: [] },
        completion: { totalRaids: 0, cleared: 0, projected: 0, percent: 0, projectedPercent: 0 },
        changeDetails: [],
        charsAfterSync: [],
        lastSync: { localSyncAt: null, autoManageSyncAt: null },
      });
      return;
    }
    if (!requireCurrentLocalSyncUser({
      userDoc,
      token,
      payload,
      scopeExplicit,
      res,
      send,
    })) return;

    const currentWeekStartMs = getCurrentResetStartMs();
    const buckets = bucketizeCurrentWeekDeltas(deltas, currentWeekStartMs);
    const summary = projectSummary(userDoc.accounts || [], buckets, {
      scope,
      currentWeekStartMs,
    });

    send(res, 200, {
      ok: true,
      scope,
      ...summary,
      lastSync: {
        localSyncAt: Number(userDoc.lastLocalSyncAt) || null,
        autoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || null,
      },
    });
  };
}

module.exports = {
  bucketizeCurrentWeekDeltas,
  createPreviewSummaryEndpoint,
  projectSummary,
};
