"use strict";

function normalizePreviousState(claimedState, previousState = {}) {
  return Object.fromEntries(
    Object.keys(claimedState).map((field) => [field, previousState[field] ?? null])
  );
}

async function claimGuildState({
  GuildConfig,
  guildId,
  guard,
  claimedState,
}) {
  return GuildConfig.findOneAndUpdate(
    { guildId, ...guard },
    { $set: claimedState },
    // Return the exact state replaced by this claim so a failed side effect
    // can restore it without relying on the earlier (possibly stale) scan.
    { new: false }
  );
}

/**
 * Roll back only while every claimed field still has the value written by
 * this slot. A newer scheduler tick/config change therefore wins instead of
 * being overwritten by a late failure from an older container.
 */
async function rollbackGuildState({
  GuildConfig,
  guildId,
  claimedState,
  previousState,
}) {
  return GuildConfig.findOneAndUpdate(
    { guildId, ...claimedState },
    { $set: normalizePreviousState(claimedState, previousState) },
    { new: true }
  );
}

/**
 * rollbackGuildState after a failed side effect, never throwing.
 * @param {object} options - rollbackGuildState options
 * @param {(error: Error) => void} onError - reports a failed rollback
 * @returns {Promise<boolean>} true when this claim was released; false when a
 *   newer claim already replaced it or the rollback failed
 */
async function releaseGuildClaim(options, onError) {
  try {
    return Boolean(await rollbackGuildState(options));
  } catch (error) {
    onError(error);
    return false;
  }
}

module.exports = {
  claimGuildState,
  rollbackGuildState,
  releaseGuildClaim,
};
