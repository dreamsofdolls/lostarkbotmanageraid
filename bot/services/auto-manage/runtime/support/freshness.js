"use strict";

const AUTO_MANAGE_BACKGROUND_STALE_MS = 30 * 60 * 1000;

function getLastAutoManageAttemptAt(userDoc) {
  return Number(userDoc?.lastAutoManageAttemptAt) || 0;
}

function isAutoManageAttemptStale(
  userDoc,
  { nowMs = Date.now(), staleMs = AUTO_MANAGE_BACKGROUND_STALE_MS } = {}
) {
  const lastAttempt = getLastAutoManageAttemptAt(userDoc);
  if (!lastAttempt) return true;
  return nowMs - lastAttempt >= staleMs;
}

function buildAutoManageAttemptStaleFilter(cutoffMs) {
  return {
    $or: [
      { lastAutoManageAttemptAt: null },
      { lastAutoManageAttemptAt: { $lte: cutoffMs } },
    ],
  };
}

module.exports = {
  AUTO_MANAGE_BACKGROUND_STALE_MS,
  getLastAutoManageAttemptAt,
  isAutoManageAttemptStale,
  buildAutoManageAttemptStaleFilter,
};
