/**
 * services/raid/channel-monitor/channel-monitor-write-plans.js
 * Shared-roster write routing for the raid text-channel monitor. This is pure
 * enough to test directly and keeps the Discord message handler focused on
 * message lifecycle, replies, and notifications.
 */

"use strict";

const {
  getAccessibleAccounts: defaultGetAccessibleAccounts,
} = require("../../access/access-control");

/**
 * Return every normalized name field that may identify a roster character.
 * @param {object} character - saved roster character
 * @returns {string[]} lowercase, trimmed lookup candidates
 */
function getAccessibleCharacterCandidates(character) {
  return [character?.charName, character?.name, character?.displayName]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve one character against accessible accounts in source order.
 * This direct helper remains for single-name callers; batch routing builds one
 * shared index instead of repeating this traversal for every character.
 * @param {Array<object>} accessibleAccounts - access-control account entries
 * @param {string} charName - requested character name
 * @returns {object|null} matching account entry plus character, or null
 */
function findAccessibleCharacterInAccounts(accessibleAccounts, charName) {
  const target = String(charName || "").trim().toLowerCase();
  if (!target) return null;
  for (const entry of accessibleAccounts || []) {
    const chars = Array.isArray(entry.account?.characters) ? entry.account.characters : [];
    for (const character of chars) {
      if (getAccessibleCharacterCandidates(character).includes(target)) {
        return { ...entry, character };
      }
    }
  }
  return null;
}

/**
 * Index an accessible-roster snapshot while preserving first-match precedence.
 * @param {Array<object>} accessibleAccounts - access-control account entries
 * @returns {Map<string, object>} normalized character name to routing metadata
 */
function buildAccessibleCharacterIndex(accessibleAccounts) {
  const byName = new Map();
  for (const entry of accessibleAccounts || []) {
    const chars = Array.isArray(entry.account?.characters) ? entry.account.characters : [];
    for (const character of chars) {
      const hit = { ...entry, character };
      for (const candidate of getAccessibleCharacterCandidates(character)) {
        // Preserve the former nested-loop rule: the first accessible match wins.
        if (!byName.has(candidate)) byName.set(candidate, hit);
      }
    }
  }
  return byName;
}

/**
 * Resolve a batch of names using one access lookup and one character index.
 * @param {object} options
 * @param {string} options.authorId - Discord user initiating the write
 * @param {string[]} options.charNames - requested characters in input order
 * @param {Function} [options.getAccessibleAccounts] - access lookup dependency
 * @param {object} [options.logger=console] - logger dependency
 * @returns {Promise<{
 *   plans: Array<object>,
 *   missingCharNames: string[],
 *   lookupFailed: boolean,
 *   noAccessibleRoster: boolean,
 * }>}
 */
async function resolveRaidChannelWriteBatch({
  authorId,
  charNames,
  getAccessibleAccounts = defaultGetAccessibleAccounts,
  logger = console,
}) {
  let accessibleAccounts = null;
  let lookupFailed = false;
  try {
    accessibleAccounts = await getAccessibleAccounts(authorId);
  } catch (lookupErr) {
    lookupFailed = true;
    logger.warn?.(
      `[raid-channel] getAccessibleAccounts failed for author ${authorId}:`,
      lookupErr?.message || lookupErr,
    );
  }

  const missingCharNames = [];
  // Every requested name targets the same access snapshot, so build its index
  // once instead of rescanning every account and character for each request.
  const characterIndex = buildAccessibleCharacterIndex(accessibleAccounts);
  const plans = (Array.isArray(charNames) ? charNames : []).map((charName, index) => {
    const hit = characterIndex.get(String(charName || "").trim().toLowerCase()) || null;
    if (!hit && !lookupFailed) missingCharNames.push(charName);
    const plan = {
      index,
      charName,
      discordId: authorId,
      executorId: null,
      rosterName: null,
    };
    if (hit && !hit.isOwn) {
      plan.discordId = hit.ownerDiscordId;
      plan.executorId = authorId;
      plan.rosterName = hit.accountName;
    }
    return plan;
  });

  return {
    plans,
    missingCharNames,
    lookupFailed,
    noAccessibleRoster:
      !lookupFailed && (!Array.isArray(accessibleAccounts) || accessibleAccounts.length === 0),
  };
}

/**
 * Resolve only the ordered write plans for callers that do not need batch
 * diagnostics.
 * @param {object} options - options accepted by resolveRaidChannelWriteBatch
 * @returns {Promise<Array<object>>} ordered routing plans
 */
async function resolveRaidChannelWritePlans(options) {
  const batch = await resolveRaidChannelWriteBatch(options);
  return batch.plans;
}

function getWritePlanSegmentKey(plan) {
  return `${plan.discordId || ""}\x1f${plan.executorId || ""}`;
}

/**
 * Group only adjacent operations with the same owner/executor route. Keeping
 * segments contiguous preserves input order and the early no-roster stop rule.
 * @param {Array<object>} plans - ordered write operations
 * @returns {Array<{key: string, plans: Array<object>}>} contiguous route segments
 */
function buildWritePlanSegments(plans) {
  const segments = [];
  for (const plan of plans || []) {
    const key = getWritePlanSegmentKey(plan);
    const previous = segments[segments.length - 1];
    if (previous && previous.key === key) {
      previous.plans.push(plan);
    } else {
      segments.push({ key, plans: [plan] });
    }
  }
  return segments;
}

/**
 * Apply one raid update across pre-resolved character write plans.
 * @param {object} options
 * @param {Array<object>} options.plans - ordered routing plans
 * @param {object} options.raidMeta - normalized raid metadata
 * @param {string} options.statusType - requested completion state
 * @param {unknown} options.effectiveGates - effective gate selection
 * @param {Function} options.applyRaidSetForDiscordId - single-write dependency
 * @param {Function|null} [options.applyRaidSetBatchForDiscordId=null] - batch dependency
 * @param {object} [options.logger=console] - logger dependency
 * @returns {Promise<Array<object>>} per-character results in input order
 */
async function applyRaidChannelWritePlans({
  plans,
  raidMeta,
  statusType,
  effectiveGates,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  logger = console,
}) {
  const updateGroups = await applyRaidChannelUpdatePlans({
    plans,
    updates: [{ raidMeta, statusType, effectiveGates }],
    applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId,
    logger,
  });
  return updateGroups[0]?.results || [];
}

/**
 * Apply several raid updates while sharing route segments across their
 * character operations.
 * @param {object} options
 * @param {Array<object>} options.plans - ordered routing plans
 * @param {Array<object>} options.updates - raid/status/gate updates
 * @param {Function} options.applyRaidSetForDiscordId - single-write dependency
 * @param {Function|null} [options.applyRaidSetBatchForDiscordId=null] - batch dependency
 * @param {object} [options.logger=console] - logger dependency
 * @returns {Promise<Array<object>>} updates paired with ordered result arrays
 */
async function applyRaidChannelUpdatePlans({
  plans,
  updates,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  logger = console,
}) {
  const list = Array.isArray(plans) ? plans : [];
  const updateList = Array.isArray(updates) ? updates.filter((update) => update?.raidMeta) : [];
  if (list.length === 0 || updateList.length === 0) return [];

  const resultsByUpdate = updateList.map(() => new Array(list.length));
  const operations = [];
  list.forEach((plan, charIndex) => {
    updateList.forEach((update, updateIndex) => {
      operations.push({
        ...plan,
        charIndex,
        updateIndex,
        raidMeta: update.raidMeta,
        statusType: update.statusType,
        effectiveGates: update.effectiveGates,
      });
    });
  });

  const assignResult = (operation, result) => {
    resultsByUpdate[operation.updateIndex][operation.charIndex] = {
      charName: operation.charName,
      ...result,
    };
    if (operation.executorId) {
      logger.log?.(
        `[raid-channel] share-write executor=${operation.executorId} owner=${operation.discordId} char=${operation.charName} raid=${operation.raidMeta.raidKey}_${operation.raidMeta.modeKey}`,
      );
    }
  };

  const assignError = (operation, err) => {
    logger.error?.(
      `[raid-channel] write for "${operation.charName}" (${operation.raidMeta.raidKey}_${operation.raidMeta.modeKey}) failed:`,
      err?.message || err,
    );
    resultsByUpdate[operation.updateIndex][operation.charIndex] = {
      charName: operation.charName,
      error: err?.message || String(err),
      matched: false,
      updated: false,
      alreadyComplete: false,
    };
  };

  const runSingle = async (operation) => {
    try {
      const result = await applyRaidSetForDiscordId({
        discordId: operation.discordId,
        executorId: operation.executorId,
        characterName: operation.charName,
        rosterName: operation.rosterName,
        raidMeta: operation.raidMeta,
        statusType: operation.statusType,
        effectiveGates: operation.effectiveGates,
      });
      assignResult(operation, result);
    } catch (err) {
      assignError(operation, err);
    }
  };

  for (const segment of buildWritePlanSegments(operations)) {
    const segmentOperations = segment.plans;
    if (
      segmentOperations.length > 1 &&
      typeof applyRaidSetBatchForDiscordId === "function"
    ) {
      try {
        const batchResults = await applyRaidSetBatchForDiscordId({
          discordId: segmentOperations[0].discordId,
          entries: segmentOperations.map((operation) => ({
            executorId: operation.executorId,
            characterName: operation.charName,
            rosterName: operation.rosterName,
            raidMeta: operation.raidMeta,
            statusType: operation.statusType,
            effectiveGates: operation.effectiveGates,
          })),
        });
        for (let i = 0; i < segmentOperations.length; i += 1) {
          assignResult(segmentOperations[i], batchResults?.[i] || {});
        }
      } catch (err) {
        for (const operation of segmentOperations) {
          assignError(operation, err);
        }
      }
    } else {
      for (const operation of segmentOperations) {
        await runSingle(operation);
      }
    }

    if (segmentOperations.some(
      (operation) => resultsByUpdate[operation.updateIndex][operation.charIndex]?.noRoster
    )) {
      break;
    }
  }

  return updateList.map((update, updateIndex) => ({
    ...update,
    results: resultsByUpdate[updateIndex].filter(Boolean),
  }));
}

module.exports = {
  applyRaidChannelWritePlans,
  applyRaidChannelUpdatePlans,
  buildWritePlanSegments,
  findAccessibleCharacterInAccounts,
  resolveRaidChannelWriteBatch,
  resolveRaidChannelWritePlans,
};
