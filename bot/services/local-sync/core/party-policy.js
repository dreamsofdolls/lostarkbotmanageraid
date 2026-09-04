"use strict";

const { resolveTarget } = require("./apply/apply-targets");

// The browser keeps at most 16 encounter participants, including the local
// source character. Mirror that trust boundary on the server so a modified
// client cannot turn one evidenced clear into an arbitrarily large fan-out.
const MAX_ENCOUNTER_PARTICIPANTS = 16;
const MAX_PARTY_TARGETS_PER_SOURCE = MAX_ENCOUNTER_PARTICIPANTS - 1;

function normalizeKeyPart(value) {
  return String(value || "").trim().toLowerCase();
}

function sourceGateKey(delta) {
  const target = resolveTarget(delta);
  const modeKey = target?.modeKey === "solo" ? "normal" : target?.modeKey;
  return [
    normalizeKeyPart(delta?.sourceCharName),
    target?.raidKey || normalizeKeyPart(delta?.boss),
    modeKey || normalizeKeyPart(delta?.difficulty),
    target?.gate || "unmapped",
  ].join("\u0000");
}

function assertPartyTargetFanout(partyDeltas) {
  if (!Array.isArray(partyDeltas)) {
    throw new Error("[local-sync/party] partyDeltas must be an array");
  }
  const targetsBySource = new Map();
  for (const delta of partyDeltas) {
    const sourceKey = sourceGateKey(delta);
    const targetName = normalizeKeyPart(delta?.charName);
    if (!targetName) continue;
    if (!targetsBySource.has(sourceKey)) targetsBySource.set(sourceKey, new Set());
    const targets = targetsBySource.get(sourceKey);
    targets.add(targetName);
    if (targets.size > MAX_PARTY_TARGETS_PER_SOURCE) {
      throw new Error(
        `[local-sync/party] too many party targets for one source Gate `
        + `(max ${MAX_PARTY_TARGETS_PER_SOURCE})`
      );
    }
  }
  return partyDeltas;
}

module.exports = {
  MAX_ENCOUNTER_PARTICIPANTS,
  MAX_PARTY_TARGETS_PER_SOURCE,
  assertPartyTargetFanout,
};
