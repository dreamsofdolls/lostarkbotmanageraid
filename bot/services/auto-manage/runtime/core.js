"use strict";

const {
  DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs: getAutoManageCooldownMsDefault,
} = require("../../access/manager");
const { createBibleClient } = require("../bible/client");
const {
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
  syncRaidProfileAfterAutoManageReport,
} = require("../reports/utils");
const { createAutoManageReportEmbeds } = require("../reports/embeds");
const {
  createAutoManageApplier,
} = require("./apply");
const {
  createAutoManageEntryKey,
} = require("./entry-key");
const {
  createAutoManageGatherer,
} = require("./gather");
const {
  createAutoManageSyncSlotManager,
} = require("./slot");
const {
  createAutoManageReconciler,
} = require("./reconcile");
const { weekResetStartMs } = require("./week-reset");

function isPublicLogDisabledError(err) {
  if (!err) return false;
  return /logs\s*not\s*enabled/i.test(String(err));
}

function createAutoManageCoreService({
  EmbedBuilder,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
  fetchRosterCharacters,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  normalizeAssignedRaid,
  ensureAssignedRaids,
  bibleLimiter,
  syncRaidProfileFromBibleCollected = async () => null,
  getAutoManageCooldownMs = getAutoManageCooldownMsDefault,
}) {
  const {
    fetchBibleCharacterMetaWithLimiter,
    fetchBibleLogsSinceWeekReset,
  } = createBibleClient({ bibleLimiter });
  const {
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
  } = createAutoManageSyncSlotManager({
    User,
    getAutoManageCooldownMs,
    defaultCooldownMs: DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  });
  const {
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
  } = createAutoManageReportEmbeds({ EmbedBuilder, UI });
  const {
    reconcileCharacterFromLogs,
  } = createAutoManageReconciler({
    ensureAssignedRaids,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
    toModeLabel,
    normalizeName,
    normalizeAssignedRaid,
    getGatesForRaid,
  });

  const autoManageEntryKey = createAutoManageEntryKey(normalizeName);
  const {
    gatherAutoManageLogsForUserDoc,
  } = createAutoManageGatherer({
    autoManageEntryKey,
    buildFetchedRosterIndexes,
    fetchBibleCharacterMetaWithLimiter,
    fetchBibleLogsSinceWeekReset,
    fetchRosterCharacters,
    findFetchedRosterMatchForCharacter,
    getCharacterClass,
    getCharacterName,
    normalizeName,
  });
  const {
    applyAutoManageCollected,
  } = createAutoManageApplier({
    autoManageEntryKey,
    getCharacterClass,
    getCharacterName,
    isPublicLogDisabledError,
    reconcileCharacterFromLogs,
  });

  async function syncAutoManageForUserDoc(userDoc, weekResetStart) {
    const collected = await gatherAutoManageLogsForUserDoc(userDoc, weekResetStart);
    return applyAutoManageCollected(userDoc, weekResetStart, collected);
  }

  async function stampAutoManageAttempt(discordId) {
    try {
      await User.updateOne(
        { discordId },
        { $set: { lastAutoManageAttemptAt: Date.now() } }
      );
    } catch (err) {
      console.warn(
        "[auto-manage] stamp attempt failed:",
        err?.message || err
      );
    }
  }

  async function gatherForCommit(discordId, weekResetStart) {
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc) return { missingUser: true, collected: undefined };
    if (!Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      await User.findOneAndUpdate(
        { discordId },
        { $set: { autoManageEnabled: true, lastAutoManageAttemptAt: Date.now() } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      return { collected: null, report: { appliedTotal: 0, perChar: [] } };
    }
    ensureFreshWeek(seedDoc);
    return {
      collected: await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart),
    };
  }

  async function commitAutoManageOn(discordId, weekResetStart, preCollected = null) {
    let collected = preCollected;
    if (!collected) {
      const gathered = await gatherForCommit(discordId, weekResetStart);
      if (gathered.missingUser) return undefined;
      if (gathered.report) return gathered.report;
      collected = gathered.collected;
    }

    let finalReport;
    let finalUserDocSnapshot = null;
    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (!fresh) return;
      finalUserDocSnapshot = null;
      fresh.autoManageEnabled = true;
      if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
        fresh.lastAutoManageAttemptAt = Date.now();
        await fresh.save();
        return;
      }
      ensureFreshWeek(fresh);
      finalReport = applyAutoManageCollected(fresh, weekResetStart, collected);
      const now = Date.now();
      stampAutoManageAttemptFromReport(fresh, finalReport, now);
      await fresh.save();
      finalUserDocSnapshot = toPlainUserDoc(fresh);
    });

    await syncRaidProfileAfterAutoManageReport({
      syncRaidProfileFromBibleCollected,
      report: finalReport,
      discordId,
      userDoc: finalUserDocSnapshot,
      weekResetStart,
      collected,
      logLabel: "[auto-manage:on]",
    });
    return finalReport;
  }

  return {
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    syncAutoManageForUserDoc,
    stampAutoManageAttempt,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
    weekResetStartMs,
  };
}

module.exports = {
  createAutoManageCoreService,
};
