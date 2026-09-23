"use strict";

const { randomUUID } = require("node:crypto");

const {
  BIBLE_ERROR_KIND,
  classifyBibleError,
} = require("../../bible/error-kinds");
const {
  hasSuccessfulAutoManageReport,
} = require("../../reports/utils");

const AUTO_MANAGE_DAILY_LEASE_MS = 20 * 60 * 1000;
const AUTO_MANAGE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
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

// A retry later the same day cannot turn a Public Log on or make Bible know
// a character name, so these failures settle the day.
const SETTLED_ERROR_KINDS = new Set([
  BIBLE_ERROR_KIND.publicLogOff,
  BIBLE_ERROR_KIND.notFound,
]);

/**
 * Build the shared scan/atomic-claim filter; opening status never postpones a
 * failed sync, and a calendar rollover never bypasses a pending retry deadline.
 * @param {{targetDayKey: string}} dailyContext
 * @param {number} [nowMs]
 * @returns {object} Mongo eligibility filter.
 */
function buildAutoManageDailyAvailabilityFilter(
  { targetDayKey },
  nowMs = Date.now()
) {
  return {
    lastAutoManageDailyFinishedDayKey: { $ne: targetDayKey },
    $and: [
      // Calendar keys still identify attempts; elapsed time controls eligibility.
      ...["lastAutoManageDailyFinishedAt", "lastAutoManageSyncAt"].map(field => ({
        $or: [
          { [field]: { $exists: false } },
          { [field]: null },
          { [field]: { $lte: nowMs - AUTO_MANAGE_DAILY_INTERVAL_MS } },
        ],
      })),
      {
        $or: [
          { autoManageDailyLeaseUntil: { $exists: false } },
          { autoManageDailyLeaseUntil: null },
          { autoManageDailyLeaseUntil: { $lte: nowMs } },
        ],
      },
      {
        $or: [
          { autoManageDailyNextAttemptAt: { $exists: false } },
          { autoManageDailyNextAttemptAt: null },
          { autoManageDailyNextAttemptAt: { $lte: nowMs } },
        ],
      },
    ],
  };
}

/** @returns {number} Attempt number, preserving unfinished retries across midnight. */
function getNextAutoManageDailyAttemptCount(userDoc, targetDayKey) {
  const pending = [AUTO_MANAGE_DAILY_OUTCOME.retryScheduled, AUTO_MANAGE_DAILY_OUTCOME.inFlight]
    .includes(userDoc?.lastAutoManageDailyOutcome);
  if (!pending && userDoc?.lastAutoManageDailyAttemptDayKey !== targetDayKey) return 1;
  return Math.max(0, Number(userDoc?.autoManageDailyAttemptCount) || 0) + 1;
}

function buildAutoManageDailyClaimUpdate({
  targetDayKey,
  attemptCount,
  nowMs = Date.now(),
  leaseToken = randomUUID(),
}) {
  return {
    $inc: { __v: 1 },
    $set: {
      lastAutoManageDailyAttemptDayKey: targetDayKey,
      autoManageDailyAttemptCount: attemptCount,
      autoManageDailyNextAttemptAt: null,
      autoManageDailyLeaseDayKey: targetDayKey,
      autoManageDailyLeaseUntil: nowMs + AUTO_MANAGE_DAILY_LEASE_MS,
      autoManageDailyLeaseToken: leaseToken,
      lastAutoManageDailyOutcome: AUTO_MANAGE_DAILY_OUTCOME.inFlight,
    },
  };
}

/** Match the unique attempt token as well as its day/count, which can repeat after reset. */
function ownsAutoManageDailyLease(userDoc, targetDayKey, attemptCount, leaseToken = "") {
  return Boolean(
    userDoc &&
      userDoc.autoManageDailyLeaseDayKey === targetDayKey &&
      Number(userDoc.autoManageDailyAttemptCount) === Number(attemptCount) &&
      String(userDoc.autoManageDailyLeaseToken || "") === leaseToken
  );
}

function clearAutoManageDailyLease(userDoc) {
  userDoc.autoManageDailyLeaseDayKey = "";
  userDoc.autoManageDailyLeaseUntil = null;
  userDoc.autoManageDailyLeaseToken = "";
}

/** Reset daily backoff and settlement state, invalidating any worker from before the user's reset. */
function resetAutoManageDailyState(userDoc) {
  clearAutoManageDailyLease(userDoc);
  userDoc.lastAutoManageDailyAttemptDayKey = "";
  userDoc.autoManageDailyAttemptCount = 0;
  userDoc.autoManageDailyNextAttemptAt = null;
  userDoc.lastAutoManageDailyFinishedDayKey = "";
  userDoc.lastAutoManageDailyFinishedAt = null;
  userDoc.lastAutoManageDailyOutcome = "";
}

function finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome, nowMs) {
  let bucket = "settled";
  if (outcome === AUTO_MANAGE_DAILY_OUTCOME.success) bucket = "synced";
  else if (outcome === AUTO_MANAGE_DAILY_OUTCOME.retryExhausted) {
    bucket = "retry-exhausted";
  }

  userDoc.lastAutoManageDailyFinishedDayKey = targetDayKey;
  userDoc.lastAutoManageDailyFinishedAt = nowMs;
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
      AUTO_MANAGE_DAILY_OUTCOME.retryExhausted,
      nowMs
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

function classifyAutoManageDailyReport(report) {
  const entries = Array.isArray(report?.perChar) ? report.perChar : [];
  if (entries.length === 0) {
    return AUTO_MANAGE_DAILY_OUTCOME.noActionable;
  }
  const errorKinds = entries
    .filter((entry) => entry?.error)
    .map((entry) => classifyBibleError(entry.error));
  if (errorKinds.some((kind) => !SETTLED_ERROR_KINDS.has(kind))) {
    return AUTO_MANAGE_DAILY_OUTCOME.retryScheduled;
  }
  if (hasSuccessfulAutoManageReport(report)) {
    return AUTO_MANAGE_DAILY_OUTCOME.success;
  }
  // Every character failed, each for a reason a retry cannot fix.
  return errorKinds.every((kind) => kind === BIBLE_ERROR_KIND.publicLogOff)
    ? AUTO_MANAGE_DAILY_OUTCOME.allPrivate
    : AUTO_MANAGE_DAILY_OUTCOME.noActionable;
}

/**
 * Settle the daily attempt or schedule its retry from the sync report.
 * @param {object} params
 * @param {object} params.userDoc - the document the report was applied to
 * @param {{perChar: object[]}} params.report - applyAutoManageCollected report
 * @param {string} params.targetDayKey
 * @param {number} params.attemptCount
 * @param {number} [params.nowMs]
 * @returns {{bucket: string, outcome: string, nextAttemptAt: number|null}}
 */
function applyAutoManageDailyReportState({
  userDoc,
  report,
  targetDayKey,
  attemptCount,
  nowMs = Date.now(),
}) {
  const outcome = classifyAutoManageDailyReport(report);
  if (outcome === AUTO_MANAGE_DAILY_OUTCOME.success) {
    return finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome, nowMs);
  }
  if (
    outcome === AUTO_MANAGE_DAILY_OUTCOME.allPrivate ||
    outcome === AUTO_MANAGE_DAILY_OUTCOME.noActionable
  ) {
    return finishAutoManageDailyAttempt(userDoc, targetDayKey, outcome, nowMs);
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
  AUTO_MANAGE_DAILY_INTERVAL_MS,
  AUTO_MANAGE_DAILY_LEASE_MS,
  AUTO_MANAGE_DAILY_RETRY_DELAYS_MS,
  AUTO_MANAGE_DAILY_MAX_ATTEMPTS,
  AUTO_MANAGE_DAILY_OUTCOME,
  buildAutoManageDailyAvailabilityFilter,
  getNextAutoManageDailyAttemptCount,
  buildAutoManageDailyClaimUpdate,
  ownsAutoManageDailyLease,
  resetAutoManageDailyState,
  scheduleAutoManageDailyRetry,
  applyAutoManageDailyReportState,
  releaseAutoManageDailyLeaseWithoutFinishing,
};
