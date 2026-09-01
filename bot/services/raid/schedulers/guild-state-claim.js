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

module.exports = {
  claimGuildState,
  rollbackGuildState,
};
