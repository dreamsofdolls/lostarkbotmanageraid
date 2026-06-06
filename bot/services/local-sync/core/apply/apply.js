/**
 * services/local-sync/core/apply.js
 * Apply path for local-sync deltas. The heavy lifting is split into
 * target mapping, roster preflight, result classification, and write
 * dispatch helpers; this file keeps the public orchestration contract.
 */

"use strict";

const {
  bucketize,
  effectiveGatesForBucket,
  isCurrentWeekDelta,
  normalizeDifficulty,
  resolveCurrentWeekStartMs,
  resolveTarget,
} = require("./apply-targets");
const {
  classifyBucketAgainstRoster,
} = require("./apply-roster");
const {
  appendPreflightDecision,
} = require("./apply-results");
const {
  applyBatchWrites,
  applySingleWrite,
  buildWriteRaidMeta,
} = require("./apply-writes");

function validateApplyDeps(discordId, deltas, deps) {
  if (typeof deps.applyRaidSetForDiscordId !== "function") {
    throw new Error("[local-sync/apply] applyRaidSetForDiscordId required in deps");
  }
  if (typeof deps.getRaidRequirementMap !== "function") {
    throw new Error("[local-sync/apply] getRaidRequirementMap required in deps");
  }
  if (!discordId) throw new Error("[local-sync/apply] discordId required");
  if (!Array.isArray(deltas)) throw new Error("[local-sync/apply] deltas must be an array");
}

function createSummaryLists() {
  return {
    applied: [],
    skipped: [],
    unmapped: [],
    rejected: [],
  };
}

function appendOutsideCurrentWeek(rejected, delta) {
  rejected.push({
    boss: delta.boss || "(unknown)",
    difficulty: delta.difficulty || "(unknown)",
    charName: delta.charName || "(unknown)",
    reason: "outside_current_week",
    lastClearMs: Number(delta.lastClearMs) || 0,
  });
}

function appendUnmappedDelta(unmapped, delta) {
  unmapped.push({
    boss: delta.boss || "(unknown)",
    difficulty: delta.difficulty || "(unknown)",
    charName: delta.charName || "(unknown)",
  });
}

function collectCurrentWeekDeltas(deltas, currentWeekStartMs, { unmapped, rejected }) {
  const currentWeekDeltas = [];
  for (const delta of deltas) {
    if (!delta.cleared) continue;
    if (!isCurrentWeekDelta(delta, currentWeekStartMs)) {
      appendOutsideCurrentWeek(rejected, delta);
      continue;
    }

    currentWeekDeltas.push(delta);
    if (!resolveTarget(delta)) appendUnmappedDelta(unmapped, delta);
  }
  return currentWeekDeltas;
}

function appendMissingRequirementMeta(unmapped, bucket) {
  unmapped.push({
    boss: `${bucket.raidKey}/${bucket.modeKey}`,
    difficulty: bucket.modeKey,
    charName: bucket.charName,
  });
}

function buildPendingWrite(bucket, raidMeta, effectiveGates) {
  return {
    bucket,
    effectiveGates,
    raidMeta: buildWriteRaidMeta(raidMeta, bucket),
  };
}

function shouldSkipForRosterPreflight(userDoc, bucket, raidMeta, effectiveGates, lists) {
  if (!userDoc) return false;
  const preflight = classifyBucketAgainstRoster(userDoc, bucket, raidMeta, effectiveGates);
  return appendPreflightDecision(preflight, bucket, effectiveGates, lists);
}

/**
 * Main entry. `deltas` shape (from web companion):
 *   [{ boss, difficulty, cleared, charName, lastClearMs }]
 *
 * Returns:
 *   { applied: [...], skipped: [...], unmapped: [...], rejected: [...] }
 */
async function applyLocalSyncDeltas(discordId, deltas, deps = {}) {
  validateApplyDeps(discordId, deltas, deps);
  const {
    applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId = null,
    getRaidRequirementMap,
    userDoc = null,
    currentWeekStartMs: injectedCurrentWeekStartMs,
    requireLocalSyncEnabled = false,
  } = deps;

  const lists = createSummaryLists();
  const currentWeekStartMs = resolveCurrentWeekStartMs(injectedCurrentWeekStartMs);
  const currentWeekDeltas = collectCurrentWeekDeltas(deltas, currentWeekStartMs, lists);
  const buckets = bucketize(currentWeekDeltas);
  const reqMap = getRaidRequirementMap();
  const pendingWrites = [];
  const useBatchApply = typeof applyRaidSetBatchForDiscordId === "function";

  for (const bucket of buckets) {
    const raidMeta = reqMap[`${bucket.raidKey}_${bucket.modeKey}`];
    if (!raidMeta) {
      appendMissingRequirementMeta(lists.unmapped, bucket);
      continue;
    }

    const effectiveGates = effectiveGatesForBucket(bucket);
    if (shouldSkipForRosterPreflight(userDoc, bucket, raidMeta, effectiveGates, lists)) {
      continue;
    }

    const pending = buildPendingWrite(bucket, raidMeta, effectiveGates);
    if (useBatchApply) {
      pendingWrites.push(pending);
      continue;
    }

    await applySingleWrite({
      discordId,
      applyRaidSetForDiscordId,
      requireLocalSyncEnabled,
      ...pending,
      lists,
    });
  }

  await applyBatchWrites({
    discordId,
    applyRaidSetBatchForDiscordId,
    requireLocalSyncEnabled,
    pendingWrites,
    lists,
  });

  return lists;
}

module.exports = {
  applyLocalSyncDeltas,
  resolveTarget,
  bucketize,
  normalizeDifficulty,
  isCurrentWeekDelta,
};
