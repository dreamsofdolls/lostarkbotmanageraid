"use strict";

const {
  createAutoManageEnableHandler,
} = require("./core/enable");
const {
  createAutoManageResetHandler,
} = require("./core/reset");
const {
  createAutoManageSyncHandler,
} = require("./core/sync");

function createAutoManageCoreActionHandlers({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  getAutoManageCooldownMs,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  syncRaidProfileFromBibleCollected = async () => null,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageSyncReportEmbed,
  buildAutoManageHiddenCharsWarningEmbed,
  stampAutoManageAttempt,
}) {
  return {
    reset: createAutoManageResetHandler({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      ComponentType,
      UI,
      User,
      saveWithRetry,
      acquireAutoManageSyncSlot,
      releaseAutoManageSyncSlot,
    }),
    on: createAutoManageEnableHandler({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      ComponentType,
      UI,
      User,
      saveWithRetry,
      ensureFreshWeek,
      acquireAutoManageSyncSlot,
      releaseAutoManageSyncSlot,
      formatAutoManageCooldownRemaining,
      weekResetStartMs,
      gatherAutoManageLogsForUserDoc,
      applyAutoManageCollected,
      isPublicLogDisabledError,
      commitAutoManageOn,
      buildAutoManageSyncReportEmbed,
      buildAutoManageHiddenCharsWarningEmbed,
      stampAutoManageAttempt,
    }),
    sync: createAutoManageSyncHandler({
      User,
      saveWithRetry,
      ensureFreshWeek,
      acquireAutoManageSyncSlot,
      releaseAutoManageSyncSlot,
      formatAutoManageCooldownRemaining,
      getAutoManageCooldownMs,
      weekResetStartMs,
      gatherAutoManageLogsForUserDoc,
      applyAutoManageCollected,
      syncRaidProfileFromBibleCollected,
      buildAutoManageSyncReportEmbed,
    }),
  };
}

module.exports = {
  createAutoManageCoreActionHandlers,
};
