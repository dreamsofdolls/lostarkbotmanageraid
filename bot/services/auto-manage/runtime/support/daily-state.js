"use strict";

const {
  hasSuccessfulAutoManageReport,
} = require("../../reports/utils");

const AUTO_MANAGE_DAILY_LEASE_MS = 20 * 60 * 1000;
const AUTO_MANAGE_DAILY_RETRY_DELAYS_MS = Object.freeze([
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
]);
const AUTO_MANAGE_DAILY_MAX_ATTEMPTS =
  AUTO_MANAGE_DAILY_RETRY_DELAYS_MS.length + 1;

const AUTO_MANAGE_DAILY_OUTCOME = Object.freeze({
  inFlight: "in-flight",
  success: "success",
  allPrivate: "all-private",
  noActionable: "no-actionable",
  retryScheduled: "retry-scheduled",
  retryExhausted: "retry-exhausted",
  disabled: "disabled",
  noRoster: "no-roster",
});

function buildAutoManageDailyAvailabilityFilter(
  { targetDayKey },
  nowMs = Date.now()
) {
  return {
    lastAutoManageDailyFinishedDayKey: { $ne: targetDayKey },
    $and: [
      {
        $or: [
          { autoManageDailyLeaseUntil: { $exists: false } },
          { autoManageDailyLeaseUntil: null },
          { autoManageDailyLeaseUntil: { $lte: nowMs } },
        ],
      },
      {
        $or: [
          { lastAutoManageDailyAttemptDayKey: { $ne: targetDayKey } },
          { autoManageDailyNextAttemptAt: { $exists: false } },
          { autoManageDailyNextAttemptAt: null },
          { autoManageDailyNextAttemptAt: { $lte: nowMs } },
        ],
      },
    ],
  };
}

function getNextAutoManageDailyAttemptCount(userDoc, targetDayKey) {
  if (userDoc?.lastAutoManageDailyAttemptDayKey !== targetDayKey) return 1;
  return Math.max(0, Number(userDoc?.autoManageDailyAttemptCount) || 0) + 1;
}

function buildAutoManageDailyClaimUpdate({
  targetDayKey,
  attemptCount,
  nowMs = Date.now(),
}) {
  return {
    $set: {
      lastAutoManageDailyAttemptDayKey: targetDayKey,
      autoManageDailyAttemptCount: attemptCount,
      autoManageDailyNextAttemptAt: null,
      autoManageDailyLeaseDayKey: targetDayKey,
      autoManageDailyLeaseUntil: nowMs + AUTO_MANAGE_DAILY_LEASE_MS,
      lastAutoManageDailyOutcome: AUTO_MANAGE_DAILY_OUTCOME.inFlight,
    },
  };
}

function ownsAutoManageDailyLease(userDoc, targetDayKey, attemptCount) {
  return Boolean(
    userDoc &&
      userDoc.autoManageDailyLeaseDayKey === targetDayKey &&
      Number(userDoc.autoManageDailyAttemptCount) === Number(attemptCount)
  );
}

function clearAutoManageDailyLease(userDoc) {
  userDoc.autoManageDailyLeaseDayKey = "";
  userDoc.autoManageDailyLeaseUntil = null;
}

function finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome) {
  let bucket = "settled";
  if (outcome === AUTO_MANAGE_DAILY_OUTCOME.success) bucket = "synced";
  else if (outcome === AUTO_MANAGE_DAILY_OUTCOME.retryExhausted) {
    bucket = "retry-exhausted";
  }

  userDoc.lastAutoManageDailyFinishedDayKey = targetDayKey;
  userDoc.lastAutoManageDailyOutcome = outcome;
  userDoc.autoManageDailyNextAttemptAt = null;
  clearAutoManageDailyLease(userDoc);
  return {
    bucket,
    outcome,
    nextAttemptAt: null,
  };
}

function scheduleAutoManageDailyRetry({
  userDoc,
  targetDayKey,
  attemptCount,
  nowMs = Date.now(),
}) {
  if (attemptCount >= AUTO_MANAGE_DAILY_MAX_ATTEMPTS) {
    return finishAutoManageDailyAttempt(
      userDoc,
      targetDayKey,
      AUTO_MANAGE_DAILY_OUTCOME.retryExhausted
    );
  }

  const retryDelay =
    AUTO_MANAGE_DAILY_RETRY_DELAYS_MS[Math.max(0, attemptCount - 1)];
  const nextAttemptAt = nowMs + retryDelay;
  userDoc.lastAutoManageDailyOutcome =
    AUTO_MANAGE_DAILY_OUTCOME.retryScheduled;
  userDoc.autoManageDailyNextAttemptAt = nextAttemptAt;
  clearAutoManageDailyLease(userDoc);
  return {
    bucket: "retry-scheduled",
    outcome: AUTO_MANAGE_DAILY_OUTCOME.retryScheduled,
    nextAttemptAt,
  };
}

function classifyAutoManageDailyReport({
  report,
  isPublicLogDisabledError,
}) {
  if (hasSuccessfulAutoManageReport(report)) {
    return AUTO_MANAGE_DAILY_OUTCOME.success;
  }

  const entries = Array.isArray(report?.perChar) ? report.perChar : [];
  if (entries.length === 0) {
    return AUTO_MANAGE_DAILY_OUTCOME.noActionable;
  }
  if (
    entries.every(
      (entry) =>
        entry?.error &&
        typeof isPublicLogDisabledError === "function" &&
        isPublicLogDisabledError(entry.error)
    )
  ) {
    return AUTO_MANAGE_DAILY_OUTCOME.allPrivate;
  }
  return AUTO_MANAGE_DAILY_OUTCOME.retryScheduled;
}

function applyAutoManageDailyReportState({
  userDoc,
  report,
  isPublicLogDisabledError,
  targetDayKey,
  attemptCount,
  nowMs = Date.now(),
}) {
  const outcome = classifyAutoManageDailyReport({
    report,
    isPublicLogDisabledError,
  });
  if (outcome === AUTO_MANAGE_DAILY_OUTCOME.success) {
    return finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome);
  }
  if (
    outcome === AUTO_MANAGE_DAILY_OUTCOME.allPrivate ||
    outcome === AUTO_MANAGE_DAILY_OUTCOME.noActionable
  ) {
    return finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome);
  }
  return scheduleAutoManageDailyRetry({
    userDoc,
    targetDayKey,
    attemptCount,
    nowMs,
  });
}

function releaseAutoManageDailyLeaseWithoutFinishing(
  userDoc,
  outcome = AUTO_MANAGE_DAILY_OUTCOME.disabled
) {
  userDoc.lastAutoManageDailyOutcome = outcome;
  userDoc.autoManageDailyNextAttemptAt = null;
  clearAutoManageDailyLease(userDoc);
}

module.exports = {
  AUTO_MANAGE_DAILY_LEASE_MS,
  AUTO_MANAGE_DAILY_RETRY_DELAYS_MS,
  AUTO_MANAGE_DAILY_MAX_ATTEMPTS,
  AUTO_MANAGE_DAILY_OUTCOME,
  buildAutoManageDailyAvailabilityFilter,
  getNextAutoManageDailyAttemptCount,
  buildAutoManageDailyClaimUpdate,
  ownsAutoManageDailyLease,
  clearAutoManageDailyLease,
  finishAutoManageDailyAttempt,
  scheduleAutoManageDailyRetry,
  classifyAutoManageDailyReport,
  applyAutoManageDailyReportState,
  releaseAutoManageDailyLeaseWithoutFinishing,
};
