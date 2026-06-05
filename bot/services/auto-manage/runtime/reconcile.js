"use strict";

const { normalizeDifficultyToModeKey } = require("../bible/log-utils");

function createAutoManageReconciler({
  ensureAssignedRaids,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  toModeLabel,
  normalizeName,
  normalizeAssignedRaid,
  getGatesForRaid,
}) {
  function reconcileCharacterFromLogs(character, logs, weekResetStart) {
    const applied = [];
    if (!Array.isArray(logs) || logs.length === 0) return applied;

    const assignedRaids = ensureAssignedRaids(character);

    // Bible returns newest-first. Process oldest-first so the latest clear
    // remains the source of truth if the same raid appears in different modes.
    const sortedLogs = [...logs].sort(
      (a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0)
    );

    for (const log of sortedLogs) {
      const ts = Number(log?.timestamp);
      if (!(ts >= weekResetStart)) continue;

      const mapping = getRaidGateForBoss(log.boss);
      if (!mapping) continue;

      const modeKey = normalizeDifficultyToModeKey(log.difficulty);
      if (!modeKey) continue;

      const raidMeta = RAID_REQUIREMENT_MAP[`${mapping.raidKey}_${modeKey}`];
      if (!raidMeta) continue;

      const difficultyLabel = toModeLabel(modeKey);
      const normalizedSelectedDiff = normalizeName(difficultyLabel);
      const existingRaid = normalizeAssignedRaid(
        assignedRaids[mapping.raidKey] || {},
        difficultyLabel,
        mapping.raidKey
      );

      let modeChange = false;
      if (existingRaid.modeKey && existingRaid.modeKey !== modeKey) {
        modeChange = true;
      }
      for (const g of getGatesForRaid(mapping.raidKey)) {
        const existingDiff = existingRaid[g]?.difficulty;
        if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
          modeChange = true;
          break;
        }
      }
      if (modeChange) {
        for (const g of getGatesForRaid(mapping.raidKey)) {
          existingRaid[g] = { difficulty: difficultyLabel, completedDate: undefined };
        }
      }
      existingRaid.modeKey = modeKey;

      // Lost Ark gates are sequential. A later-gate clear is proof that prior
      // gates in the same raid/mode were cleared too. Fill missing prior gates
      // without overwriting a timestamp captured from its own log.
      const officialGates = getGatesForRaid(mapping.raidKey);
      const gateIndex = officialGates.indexOf(mapping.gate);
      if (gateIndex < 0) continue;
      const effectiveGates = officialGates.slice(0, gateIndex + 1);
      for (const gate of effectiveGates) {
        const isLoggedGate = gate === mapping.gate;
        const priorTs = Number(existingRaid[gate]?.completedDate) || 0;
        const shouldStamp = isLoggedGate ? ts > priorTs : priorTs <= 0;
        if (!shouldStamp) continue;

        existingRaid[gate] = {
          difficulty: difficultyLabel,
          completedDate: ts,
        };
        existingRaid.modeKey = modeKey;
        applied.push({
          raidKey: mapping.raidKey,
          raidLabel: raidMeta.label,
          gate,
          modeKey,
          difficulty: difficultyLabel,
          timestamp: ts,
          boss: log.boss,
          inferred: !isLoggedGate,
        });
      }

      assignedRaids[mapping.raidKey] = existingRaid;
    }

    character.assignedRaids = assignedRaids;
    return applied;
  }

  return {
    reconcileCharacterFromLogs,
  };
}

module.exports = {
  createAutoManageReconciler,
};
