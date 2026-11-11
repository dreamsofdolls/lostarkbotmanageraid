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
  User,
  saveWithRetry,
  ensureFreshWeek,
  acquireAutoManageSyncSlot,  formatAutoManageCooldownRemaining,
  getAutoManageCooldownMs,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
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
      User,
      saveWithRetry,
      acquireAutoManageSyncSlot,    }),
    on: createAutoManageEnableHandler({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      ComponentType,
      User,
      saveWithRetry,
      ensureFreshWeek,
      acquireAutoManageSyncSlot,      formatAutoManageCooldownRemaining,
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
      acquireAutoManageSyncSlot,      formatAutoManageCooldownRemaining,
      getAutoManageCooldownMs,
      weekResetStartMs,
      gatherAutoManageLogsForUserDoc,
      applyAutoManageCollected,
      buildAutoManageSyncReportEmbed,
    }),
  };
}

module.exports = {
  createAutoManageCoreActionHandlers,
};
