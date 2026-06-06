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
  const inFlightAutoManageSyncs = new Set();

  /**
   * Atomically claim a sync slot for this user. The slot is reserved before
   * any await so two concurrent interactions cannot both enter the sync path.
   */
  async function acquireAutoManageSyncSlot(discordId, { ignoreCooldown = false } = {}) {
    if (inFlightAutoManageSyncs.has(discordId)) {
      return { acquired: false, reason: "in-flight" };
    }

    inFlightAutoManageSyncs.add(discordId);
    try {
      const user = await User.findOne(
        { discordId },
        { lastAutoManageAttemptAt: 1 }
      ).lean();
      const lastAttempt = user?.lastAutoManageAttemptAt || 0;
      const elapsed = Date.now() - lastAttempt;
      const effectiveCooldownMs = getAutoManageCooldownMs(discordId);
      if (!ignoreCooldown && lastAttempt && elapsed < effectiveCooldownMs) {
        inFlightAutoManageSyncs.delete(discordId);
        return {
          acquired: false,
          reason: "cooldown",
          remainingMs: effectiveCooldownMs - elapsed,
        };
      }
      return { acquired: true };
    } catch (err) {
      inFlightAutoManageSyncs.delete(discordId);
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
  formatAutoManageCooldownRemaining,
};
