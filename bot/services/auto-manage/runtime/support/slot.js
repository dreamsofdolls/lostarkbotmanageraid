"use strict";

function formatAutoManageCooldownRemaining(remainingMs) {
  const secs = Math.max(1, Math.ceil(remainingMs / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs - mins * 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

function createAutoManageSyncSlotManager({
  User,
  getAutoManageCooldownMs,
  defaultCooldownMs,
}) {
  // discordId -> the token of the acquire that holds the slot.
  const inFlightAutoManageSyncs = new Map();

  // Frees the slot only while `token` still holds it, so a repeated or late
  // release cannot free the slot of a sync that started after it.
  function releaseHeld(discordId, token) {
    if (inFlightAutoManageSyncs.get(discordId) === token) inFlightAutoManageSyncs.delete(discordId);
  }

  // A refused acquire holds nothing, so its release does nothing.
  const refused = (fields) => ({ acquired: false, ...fields, release: () => {} });

  /**
   * Atomically claim a sync slot for this user. The slot is reserved before
   * any await so two concurrent interactions cannot both enter the sync path.
   * Every result carries `release()`; callers call it unconditionally.
   * @param {string} discordId - the user whose sync takes the slot
   * @param {{ignoreCooldown?: boolean}} [options] - skip the attempt cooldown
   * @returns {Promise<{acquired: boolean, reason?: string, remainingMs?: number, release: Function}>}
   */
  async function acquireAutoManageSyncSlot(discordId, { ignoreCooldown = false } = {}) {
    if (inFlightAutoManageSyncs.has(discordId)) return refused({ reason: "in-flight" });

    const token = {};
    inFlightAutoManageSyncs.set(discordId, token);
    try {
      const user = await User.findOne(
        { discordId },
        { lastAutoManageAttemptAt: 1 }
      ).lean();
      const lastAttempt = user?.lastAutoManageAttemptAt || 0;
      const elapsed = Date.now() - lastAttempt;
      const effectiveCooldownMs = getAutoManageCooldownMs(discordId);
      if (!ignoreCooldown && lastAttempt && elapsed < effectiveCooldownMs) {
        releaseHeld(discordId, token);
        return refused({ reason: "cooldown", remainingMs: effectiveCooldownMs - elapsed });
      }
      return { acquired: true, release: () => releaseHeld(discordId, token) };
    } catch (err) {
      releaseHeld(discordId, token);
      throw err;
    }
  }

  function releaseAutoManageSyncSlot(discordId) {
    inFlightAutoManageSyncs.delete(discordId);
  }

  return {
    AUTO_MANAGE_SYNC_COOLDOWN_MS: defaultCooldownMs,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
  };
}

module.exports = {
  createAutoManageSyncSlotManager,
};
