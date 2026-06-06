"use strict";

const { getRaidGateForBoss, getGatesForRaid } = require("../../../../models/Raid");
const { getCurrentResetStartMs } = require("../../../raid/schedulers/weekly-reset");
const { normalizeDifficulty } = require("../catalog");

function resolveTarget(delta) {
  const bossInfo = getRaidGateForBoss(delta.boss);
  if (!bossInfo) return null;
  const modeKey = normalizeDifficulty(delta.difficulty) || "normal";
  return {
    raidKey: bossInfo.raidKey,
    modeKey,
    gate: bossInfo.gate,
  };
}

function bucketize(deltas) {
  const buckets = new Map();
  for (const d of deltas) {
    if (!d.cleared) continue;
    const target = resolveTarget(d);
    if (!target) continue;
    const charName = String(d.charName || "").trim();
    if (!charName) continue;
    const allGates = getGatesForRaid(target.raidKey);
    const gateIndex = allGates.indexOf(target.gate);
    if (gateIndex < 0) continue;
    const bucketKey = `${charName.toLowerCase()}::${target.raidKey}::${target.modeKey}`;
    const existing = buckets.get(bucketKey);
    const lastClearMs = Number(d.lastClearMs) || 0;
    if (!existing || gateIndex > existing.gateIndex) {
      buckets.set(bucketKey, {
        charName,
        raidKey: target.raidKey,
        modeKey: target.modeKey,
        gateIndex,
        lastClearMs,
      });
    } else if (gateIndex === existing.gateIndex && lastClearMs > existing.lastClearMs) {
      existing.lastClearMs = lastClearMs;
    }
  }
  return [...buckets.values()];
}

function resolveCurrentWeekStartMs(value) {
  if (typeof value === "function") {
    const resolved = Number(value());
    return Number.isFinite(resolved) ? resolved : getCurrentResetStartMs();
  }
  if (Number(value) >= 0) return Number(value);
  return getCurrentResetStartMs();
}

function isCurrentWeekDelta(delta, currentWeekStartMs) {
  return Number(delta?.lastClearMs) >= currentWeekStartMs;
}

function effectiveGatesForBucket(bucket) {
  return getGatesForRaid(bucket.raidKey).slice(0, bucket.gateIndex + 1);
}

module.exports = {
  bucketize,
  effectiveGatesForBucket,
  isCurrentWeekDelta,
  normalizeDifficulty,
  resolveCurrentWeekStartMs,
  resolveTarget,
};
