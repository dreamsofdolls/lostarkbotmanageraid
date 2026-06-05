/**
 * services/raid/channel-monitor-write-plans.js
 * Shared-roster write routing for the raid text-channel monitor. This is pure
 * enough to test directly and keeps the Discord message handler focused on
 * message lifecycle, replies, and notifications.
 */

"use strict";

const {
  getAccessibleAccounts: defaultGetAccessibleAccounts,
} = require("../access/access-control");

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

async function resolveRaidChannelWritePlans({
  authorId,
  charNames,
  getAccessibleAccounts = defaultGetAccessibleAccounts,
  logger = console,
}) {
  let accessibleAccounts = null;
  try {
    accessibleAccounts = await getAccessibleAccounts(authorId);
  } catch (lookupErr) {
    logger.warn?.(
      `[raid-channel] getAccessibleAccounts failed for author ${authorId}:`,
      lookupErr?.message || lookupErr,
    );
  }

  return (Array.isArray(charNames) ? charNames : []).map((charName, index) => {
    const hit = findAccessibleCharacterInAccounts(accessibleAccounts, charName);
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
  const list = Array.isArray(plans) ? plans : [];
  const results = new Array(list.length);

  const assignResult = (plan, result) => {
    results[plan.index] = { charName: plan.charName, ...result };
    if (plan.executorId) {
      logger.log?.(
        `[raid-channel] share-write executor=${plan.executorId} owner=${plan.discordId} char=${plan.charName} raid=${raidMeta.raidKey}_${raidMeta.modeKey}`,
      );
    }
  };

  const assignError = (plan, err) => {
    logger.error?.(`[raid-channel] write for "${plan.charName}" failed:`, err?.message || err);
    results[plan.index] = {
      charName: plan.charName,
      error: err?.message || String(err),
      matched: false,
      updated: false,
      alreadyComplete: false,
    };
  };

  const runSingle = async (plan) => {
    try {
      const result = await applyRaidSetForDiscordId({
        discordId: plan.discordId,
        executorId: plan.executorId,
        characterName: plan.charName,
        rosterName: plan.rosterName,
        raidMeta,
        statusType,
        effectiveGates,
      });
      assignResult(plan, result);
    } catch (err) {
      assignError(plan, err);
    }
  };

  for (const segment of buildWritePlanSegments(list)) {
    const segmentPlans = segment.plans;
    if (
      segmentPlans.length > 1 &&
      typeof applyRaidSetBatchForDiscordId === "function"
    ) {
      try {
        const batchResults = await applyRaidSetBatchForDiscordId({
          discordId: segmentPlans[0].discordId,
          entries: segmentPlans.map((plan) => ({
            executorId: plan.executorId,
            characterName: plan.charName,
            rosterName: plan.rosterName,
            raidMeta,
            statusType,
            effectiveGates,
          })),
        });
        for (let i = 0; i < segmentPlans.length; i += 1) {
          assignResult(segmentPlans[i], batchResults?.[i] || {});
        }
      } catch (err) {
        for (const plan of segmentPlans) {
          assignError(plan, err);
        }
      }
    } else {
      for (const plan of segmentPlans) {
        await runSingle(plan);
      }
    }

    if (segmentPlans.some((plan) => results[plan.index]?.noRoster)) {
      break;
    }
  }

  return results.filter(Boolean);
}

module.exports = {
  applyRaidChannelWritePlans,
  buildWritePlanSegments,
  findAccessibleCharacterInAccounts,
  getAccessibleCharacterCandidates,
  resolveRaidChannelWritePlans,
};
