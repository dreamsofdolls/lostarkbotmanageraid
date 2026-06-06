"use strict";

const {
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
} = require("./config");

function ensureSharedTasks(account) {
  if (!account || typeof account !== "object") return [];
  if (!Array.isArray(account.sharedTasks)) account.sharedTasks = [];
  return account.sharedTasks;
}

function countSharedTasksByReset(sharedTasks, reset, nowMs = Date.now()) {
  return (Array.isArray(sharedTasks) ? sharedTasks : []).filter(
    (task) =>
      task?.reset === reset &&
      !isSharedTaskArchived(task) &&
      !isSharedTaskExpired(task, nowMs)
  ).length;
}

function sharedTaskCapForReset(reset) {
  if (reset === "daily") return SHARED_TASK_CAP_DAILY;
  if (reset === "weekly") return SHARED_TASK_CAP_WEEKLY;
  return SHARED_TASK_CAP_SCHEDULED;
}

/**
 * Parse a YYYY-MM-DD expiry-date string from the /raid-task add modal
 * into an end-of-day UTC ms timestamp.
 */
function parseSharedTaskExpiresAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return NaN;
  }
  return ms;
}

function isSharedTaskArchived(task) {
  return Number(task?.archivedAt) > 0;
}

function isSharedTaskExpired(task, nowMs = Date.now()) {
  const expiresAt = Number(task?.expiresAt) || 0;
  return expiresAt > 0 && expiresAt < nowMs;
}

function getVisibleSharedTasks(account, nowMs = Date.now()) {
  return ensureSharedTasks(account).filter(
    (task) =>
      task?.taskId &&
      !isSharedTaskArchived(task) &&
      !isSharedTaskExpired(task, nowMs)
  );
}

module.exports = {
  ensureSharedTasks,
  countSharedTasksByReset,
  sharedTaskCapForReset,
  parseSharedTaskExpiresAt,
  isSharedTaskArchived,
  isSharedTaskExpired,
  getVisibleSharedTasks,
};
