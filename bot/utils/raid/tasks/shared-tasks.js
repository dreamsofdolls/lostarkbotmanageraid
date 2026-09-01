"use strict";

const { normalizeName } = require("../common/shared");
const {
  SCHEDULED_RESET,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_SCHEDULED,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_PRESETS,
  getSharedTaskPreset,
} = require("./shared-tasks/config");
const {
  countSharedTasksByReset,
  ensureSharedTasks,
  getVisibleSharedTasks,
  parseSharedTaskExpiresAt,
  sharedTaskCapForReset,
} = require("./shared-tasks/state");
const {
  resolveScheduledSharedTaskState,
} = require("./shared-tasks/schedule");
const {
  formatSharedResetLabel,
  getNextSharedTaskTransitionMs,
  getSharedTaskDisplay,
} = require("./shared-tasks/display");

module.exports = {
  SCHEDULED_RESET,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_SCHEDULED,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_PRESETS,
  countSharedTasksByReset,
  ensureSharedTasks,
  formatSharedResetLabel,
  getNextSharedTaskTransitionMs,
  getSharedTaskDisplay,
  getSharedTaskPreset,
  getVisibleSharedTasks,
  normalizeName,
  parseSharedTaskExpiresAt,
  resolveScheduledSharedTaskState,
  sharedTaskCapForReset,
};
