"use strict";

function createDiscordIdentityCache({ User, buildDiscordIdentityFields, log = console }) {
  if (!User) throw new Error("[user-identity-cache] User model required");
  if (typeof buildDiscordIdentityFields !== "function") {
    throw new Error("[user-identity-cache] buildDiscordIdentityFields required");
  }

  return async function cacheDiscordIdentityForExistingUser(interaction) {
    const discordId = interaction?.user?.id;
    if (!discordId) return;

    const identity = buildDiscordIdentityFields(interaction);
    if (!Object.values(identity).some(Boolean)) return;

    try {
      await User.updateOne(
        {
          discordId,
          $or: Object.entries(identity).map(([field, value]) => ({
            [field]: { $ne: value },
          })),
        },
        { $set: identity }
      );
    } catch (err) {
      log.warn(
        `[user-cache] failed to cache Discord identity for ${discordId}:`,
        err?.message || err
      );
    }
  };
}

module.exports = {
  createDiscordIdentityCache,
};
