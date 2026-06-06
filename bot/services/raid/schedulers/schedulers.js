"use strict";

const { t, getGuildLanguage, getUserLanguage } = require("../../i18n");
const {
  ARTIST_QUIET_START_HOUR_VN,
  ARTIST_QUIET_END_HOUR_VN,
  getTargetCleanupSlotKey,
  getTargetVNDayKey,
  getCurrentVNHour,
  isInArtistQuietHours,
  hasReachedArtistWakeupBoundary,
} = require("../../../utils/raid/schedule/artist-clock");
const {
  cleanupCountBucket,
  pickBedtimeNoticeContent,
  pickWakeupNoticeContent,
  buildCleanupNoticePreview,
} = require("../../../utils/raid/schedule/cleanup-notices");
const {
  MAINTENANCE_DAY_VN,
  MAINTENANCE_HOUR_VN,
  MAINTENANCE_MINUTE_VN,
  MAINTENANCE_TICK_MS,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenancePreview,
  getMaintenanceSlotConfigSnapshot,
  buildMaintenanceConfigQuery,
} = require("../../../utils/raid/schedule/maintenance");
const { dailyResetStartMs } = require("../../../utils/raid/schedule/reset-windows");
const { postChannelAnnouncement } = require("../channel-announcements");
const {
  createAutoCleanupSchedulerService,
} = require("./auto-cleanup-scheduler");
const {
  createAutoManageDailySchedulerService,
} = require("./auto-manage-daily-scheduler");
const { createPrivateLogNudgeService } = require("./auto-manage-private-log-nudge");
const { createMaintenanceSchedulerService } = require("./maintenance-scheduler");
const { createSideTaskResetService } = require("./side-task-reset");

function createRaidSchedulerService({
  GuildConfig,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getAnnouncementsConfig,
  cleanupRaidChannelMessages,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  syncRaidProfileFromBibleCollected = async () => null,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
}) {
  const sideTaskResetService = createSideTaskResetService({
    User,
    dailyResetStartMs,
    weekResetStartMs,
  });

  const { nudgeStuckPrivateLogUser } = createPrivateLogNudgeService({
    GuildConfig,
    User,
    getAnnouncementsConfig,
    getUserLanguage,
    t,
    postChannelAnnouncement,
  });

  const autoCleanupService = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig,
    cleanupRaidChannelMessages,
    getGuildLanguage,
    postChannelAnnouncement,
  });

  const maintenanceService = createMaintenanceSchedulerService({
    GuildConfig,
    getAnnouncementsConfig,
    getGuildLanguage,
    postChannelAnnouncement,
  });

  const autoManageDailyService = createAutoManageDailySchedulerService({
    User,
    saveWithRetry,
    ensureFreshWeek,
    weekResetStartMs,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    syncRaidProfileFromBibleCollected,
    isPublicLogDisabledError,
    stampAutoManageAttempt,
    nudgeStuckPrivateLogUser,
  });

  return {
    AUTO_CLEANUP_TICK_MS: autoCleanupService.AUTO_CLEANUP_TICK_MS,
    AUTO_MANAGE_DAILY_TICK_MS: autoManageDailyService.AUTO_MANAGE_DAILY_TICK_MS,
    MAINTENANCE_TICK_MS,
    MAINTENANCE_DAY_VN,
    MAINTENANCE_HOUR_VN,
    MAINTENANCE_MINUTE_VN,
    ARTIST_QUIET_START_HOUR_VN,
    ARTIST_QUIET_END_HOUR_VN,
    postChannelAnnouncement,
    getTargetCleanupSlotKey,
    getTargetVNDayKey,
    getCurrentVNHour,
    isInArtistQuietHours,
    hasReachedArtistWakeupBoundary,
    buildCleanupNoticePreview,
    cleanupCountBucket,
    pickBedtimeNoticeContent,
    pickWakeupNoticeContent,
    getMaintenanceSlotForNow,
    pickMaintenanceVariant,
    buildMaintenancePreview,
    buildMaintenanceConfigQuery,
    getMaintenanceSlotConfigSnapshot,
    startRaidChannelScheduler: autoCleanupService.startRaidChannelScheduler,
    startAutoManageDailyScheduler: autoManageDailyService.startAutoManageDailyScheduler,
    startMaintenanceScheduler: maintenanceService.startMaintenanceScheduler,
    startSideTaskResetScheduler: sideTaskResetService.startSideTaskResetScheduler,
    dailyResetStartMs,
    resetExpiredSideTasks: sideTaskResetService.resetExpiredSideTasks,
    getAutoCleanupSchedulerStartedAtMs: autoCleanupService.getAutoCleanupSchedulerStartedAtMs,
    getAutoManageSchedulerStartedAtMs: autoManageDailyService.getAutoManageSchedulerStartedAtMs,
    getMaintenanceSchedulerStartedAtMs: maintenanceService.getMaintenanceSchedulerStartedAtMs,
    getSideTaskSchedulerStartedAtMs: sideTaskResetService.getSideTaskSchedulerStartedAtMs,
  };
}

module.exports = {
  createRaidSchedulerService,
};
