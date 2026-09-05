"use strict";

const {
  stampAutoManageAttemptFromReport,
} = require("../../auto-manage/reports/utils");
const {
  getAutoManageDailyContext,
} = require("../../auto-manage/runtime/support/daily-backfill");
const {
  AUTO_MANAGE_DAILY_OUTCOME,
  buildAutoManageDailyAvailabilityFilter,
  getNextAutoManageDailyAttemptCount,
  buildAutoManageDailyClaimUpdate,
  ownsAutoManageDailyLease,
  scheduleAutoManageDailyRetry,
  applyAutoManageDailyReportState,
  releaseAutoManageDailyLeaseWithoutFinishing,
} = require("../../auto-manage/runtime/support/daily-state");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");

// The persisted 24-hour gate limits sync frequency; short ticks drain due users
// in small batches without waiting another half hour after each batch.
const AUTO_MANAGE_DAILY_TICK_MS = 5 * 60 * 1000;
const AUTO_MANAGE_DAILY_BATCH_SIZE = 6;
const OUTCOME_COUNTER_KEY_BY_BUCKET = new Map([
  ["synced", "syncedCount"],
  ["settled", "settledCount"],
  ["retry-scheduled", "retryScheduledCount"],
  ["retry-exhausted", "retryExhaustedCount"],
  ["failed", "failedCount"],
]);

function buildAutoManageDailyCandidateQuery(dailyContext, nowMs = Date.now()) {
  return {
    autoManageEnabled: true,
    localSyncEnabled: { $ne: true },
    "accounts.0": { $exists: true },
    ...buildAutoManageDailyAvailabilityFilter(dailyContext, nowMs),
  };
}

function buildAutoManageDailyClaimQuery(
  discordId,
  dailyContext,
  nowMs = Date.now()
) {
  return {
    discordId,
    ...buildAutoManageDailyCandidateQuery(dailyContext, nowMs),
  };
}

function didClaimDailyBackfill(result) {
  return Number(result?.modifiedCount ?? result?.nModified ?? 0) > 0;
}

function createOutcomeCounters() {
  return {
    syncedCount: 0,
    settledCount: 0,
    retryScheduledCount: 0,
    retryExhaustedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };
}

async function settleUnavailableDailyCandidate({
  userDoc,
  targetDayKey,
  attemptCount,
  nowMs,
}) {
  if (!ownsAutoManageDailyLease(userDoc, targetDayKey, attemptCount)) {
    return {
      handled: true,
      transition: { bucket: "skipped", outcome: "superseded" },
    };
  }

  let outcome = null;
  if (!userDoc.autoManageEnabled || userDoc.localSyncEnabled) {
    outcome = AUTO_MANAGE_DAILY_OUTCOME.disabled;
  } else if (!Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    outcome = AUTO_MANAGE_DAILY_OUTCOME.noRoster;
  }
  if (!outcome) return { handled: false, transition: null };

  userDoc.lastAutoManageAttemptAt = nowMs;
  releaseAutoManageDailyLeaseWithoutFinishing(userDoc, outcome);
  await userDoc.save();
  return {
    handled: true,
    transition: { bucket: "skipped", outcome },
  };
}

async function loadDailyCandidateSettlement({
  User,
  discordId,
  dailyContext,
  attemptCount,
  nowMs,
}) {
  const fresh = await User.findOne({ discordId });
  const settlement = await settleUnavailableDailyCandidate({
    userDoc: fresh,
    targetDayKey: dailyContext.targetDayKey,
    attemptCount,
    nowMs,
  });
  return { fresh, settlement };
}

async function persistTransientDailyFailure({
  User,
  saveWithRetry,
  discordId,
  dailyContext,
  attemptCount,
  nowMs,
}) {
  let transition = { bucket: "skipped", outcome: "superseded" };
  await saveWithRetry(async () => {
    const { fresh, settlement } = await loadDailyCandidateSettlement({
      User,
      discordId,
      dailyContext,
      attemptCount,
      nowMs,
    });
    if (settlement.handled) {
      transition = settlement.transition;
      return;
    }

    fresh.lastAutoManageAttemptAt = nowMs;
    transition = scheduleAutoManageDailyRetry({
      userDoc: fresh,
      targetDayKey: dailyContext.targetDayKey,
      attemptCount,
      nowMs,
    });
    await fresh.save();
  });
  return transition;
}

async function loadEligibleDailySeed(User, discordId) {
  const seedDoc = await User.findOne({ discordId });
  if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
    return {
      seedDoc: null,
      transition: { bucket: "skipped", outcome: "missing-roster" },
    };
  }
  if (!seedDoc.autoManageEnabled) {
    return {
      seedDoc: null,
      transition: { bucket: "skipped", outcome: "disabled" },
    };
  }
  return { seedDoc, transition: null };
}

async function persistCollectedDailyReport({
  User,
  saveWithRetry,
  discordId,
  dailyContext,
  attemptCount,
  nowMs,
  ensureFreshWeek,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  weekResetStart,
  collected,
}) {
  let report = null;
  let transition = { bucket: "skipped", outcome: "superseded" };
  await saveWithRetry(async () => {
    const { fresh, settlement } = await loadDailyCandidateSettlement({
      User,
      discordId,
      dailyContext,
      attemptCount,
      nowMs,
    });
    if (settlement.handled) {
      transition = settlement.transition;
      return;
    }

    ensureFreshWeek(fresh);
    report = applyAutoManageCollected(fresh, weekResetStart, collected);
    stampAutoManageAttemptFromReport(fresh, report, nowMs);
    transition = applyAutoManageDailyReportState({
      userDoc: fresh,
      report,
      isPublicLogDisabledError,
      targetDayKey: dailyContext.targetDayKey,
      attemptCount,
      nowMs,
    });
    await fresh.save();
  });
  return { report, transition };
}

async function settleCandidateFailure({
  err,
  claimed,
  User,
  saveWithRetry,
  discordId,
  dailyContext,
  attemptCount,
  nowMs,
}) {
  let transition = { bucket: "failed", outcome: "unpersisted-failure" };
  if (claimed) {
    try {
      transition = await persistTransientDailyFailure({
        User,
        saveWithRetry,
        discordId,
        dailyContext,
        attemptCount,
        nowMs,
      });
    } catch (persistErr) {
      console.warn(
        `[auto-manage daily] user ${discordId} retry state failed:`,
        persistErr?.message || persistErr
      );
    }
  }
  console.warn(
    `[auto-manage daily] user ${discordId} sync failed:`,
    err?.message || err
  );
  return transition;
}

async function syncCandidate({
  discordId,
  weekResetStart,
  dailyContext,
  nowMs,
  deps,
}) {
  const {
    User,
    saveWithRetry,
    ensureFreshWeek,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    isPublicLogDisabledError,
  } = deps;

  const guard = await acquireAutoManageSyncSlot(discordId);
  if (!guard.acquired) {
    return { bucket: "skipped", outcome: guard.reason || "slot-unavailable" };
  }

  let claimed = false;
  let attemptCount = 0;
  try {
    const seed = await loadEligibleDailySeed(User, discordId);
    if (seed.transition) return seed.transition;
    const { seedDoc } = seed;

    attemptCount = getNextAutoManageDailyAttemptCount(
      seedDoc,
      dailyContext.targetDayKey
    );
    const claim = await User.updateOne(
      buildAutoManageDailyClaimQuery(discordId, dailyContext, nowMs),
      buildAutoManageDailyClaimUpdate({
        targetDayKey: dailyContext.targetDayKey,
        attemptCount,
        nowMs,
      })
    );
    if (!didClaimDailyBackfill(claim)) {
      return { bucket: "skipped", outcome: "claimed-or-not-due" };
    }
    claimed = true;

    ensureFreshWeek(seedDoc);
    const collected = await gatherAutoManageLogsForUserDoc(
      seedDoc,
      weekResetStart
    );

    const persisted = await persistCollectedDailyReport({
      User,
      saveWithRetry,
      discordId,
      dailyContext,
      attemptCount,
      nowMs,
      ensureFreshWeek,
      applyAutoManageCollected,
      isPublicLogDisabledError,
      weekResetStart,
      collected,
    });

    return persisted.transition;
  } catch (err) {
    // Persist the retry/lease state before finally releases the shared sync slot.
    return await settleCandidateFailure({
      err,
      claimed,
      User,
      saveWithRetry,
      discordId,
      dailyContext,
      attemptCount,
      nowMs,
    });
  } finally {
    releaseAutoManageSyncSlot(discordId);
  }
}

function applyOutcomeCounter(counters, bucket) {
  const counterKey = OUTCOME_COUNTER_KEY_BY_BUCKET.get(bucket) || "skippedCount";
  counters[counterKey] += 1;
}

/**
 * Run silent background syncs for opted-in users, at most once per 24 hours
 * after a settled run/successful sync, with bounded retries for transient errors.
 * @param {object} deps - User persistence, shared sync lock and Bible services.
 * @returns {object} Scheduler lifecycle and a deterministic tick entrypoint.
 */
function createAutoManageDailySchedulerService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  processEnv = process.env,
}) {
  async function runAutoManageDailyTick(client, now = new Date()) {
    if (processEnv.AUTO_MANAGE_DAILY_DISABLED === "true") return;

    const instant = now instanceof Date ? now : new Date(now);
    const nowMs = instant.getTime();
    const dailyContext = getAutoManageDailyContext(instant);
    const candidates = await User.find(
      buildAutoManageDailyCandidateQuery(dailyContext, nowMs)
    )
      .sort({ lastAutoManageAttemptAt: 1 })
      .limit(AUTO_MANAGE_DAILY_BATCH_SIZE)
      .select("discordId")
      .lean();

    if (candidates.length === 0) return;

    const counters = createOutcomeCounters();
    const weekResetStart = weekResetStartMs();
    for (const { discordId } of candidates) {
      const outcome = await syncCandidate({
        discordId,
        weekResetStart,
        dailyContext,
        nowMs,
        deps: {
          User,
          saveWithRetry,
          ensureFreshWeek,
          acquireAutoManageSyncSlot,
          releaseAutoManageSyncSlot,
          gatherAutoManageLogsForUserDoc,
          applyAutoManageCollected,
          isPublicLogDisabledError,
        },
      });
      applyOutcomeCounter(counters, outcome.bucket);
    }

    console.log(
      `[auto-manage daily] target=${dailyContext.targetDayKey}: ${candidates.length} candidate(s) | synced ${counters.syncedCount} | settled ${counters.settledCount} | retry ${counters.retryScheduledCount} | exhausted ${counters.retryExhaustedCount} | skipped ${counters.skippedCount} | failed ${counters.failedCount}`
    );
  }

  const autoManageDailyRunner = createNonOverlappingIntervalRunner({
    tickMs: AUTO_MANAGE_DAILY_TICK_MS,
    runTick: runAutoManageDailyTick,
    overlapMessage: "[auto-manage daily] previous tick still running - skipping this fire to avoid overlap",
    errorMessage: "[auto-manage daily] scheduler tick failed:",
  });

  return {
    AUTO_MANAGE_DAILY_TICK_MS,
    buildAutoManageDailyCandidateQuery,
    runAutoManageDailyTick,
    startAutoManageDailyScheduler: (client) => autoManageDailyRunner.start(client),
    getAutoManageSchedulerStartedAtMs: autoManageDailyRunner.getStartedAtMs,
  };
}

module.exports = {
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  buildAutoManageDailyCandidateQuery,
  buildAutoManageDailyClaimQuery,
  applyOutcomeCounter,
  createOutcomeCounters,
  createAutoManageDailySchedulerService,
  persistTransientDailyFailure,
};
