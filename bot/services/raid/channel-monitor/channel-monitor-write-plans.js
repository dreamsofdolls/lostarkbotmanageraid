/**
 * services/raid/channel-monitor-write-plans.js
 * Shared-roster write routing for the raid text-channel monitor. This is pure
 * enough to test directly and keeps the Discord message handler focused on
 * message lifecycle, replies, and notifications.
 */

"use strict";

const {
  getAccessibleAccounts: defaultGetAccessibleAccounts,
} = require("../../access/access-control");

function getAccessibleCharacterCandidates(character) {
  return [character?.charName, character?.name, character?.displayName]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

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
  const plans = (Array.isArray(charNames) ? charNames : []).map((charName, index) => {
    const hit = findAccessibleCharacterInAccounts(accessibleAccounts, charName);
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

async function resolveRaidChannelWritePlans(options) {
  const batch = await resolveRaidChannelWriteBatch(options);
  return batch.plans;
}

function getWritePlanSegmentKey(plan) {
  return `${plan.discordId || ""}\x1f${plan.executorId || ""}`;
}

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
  getAccessibleCharacterCandidates,
  resolveRaidChannelWriteBatch,
  resolveRaidChannelWritePlans,
};
