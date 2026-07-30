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

const AUTO_MANAGE_DAILY_TICK_MS = 30 * 60 * 1000;
const AUTO_MANAGE_DAILY_BATCH_SIZE = 6;

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

function shouldNudgePrivateLogUser({ report, isPublicLogDisabledError }) {
  return Boolean(
    report &&
      report.perChar.length > 0 &&
      report.perChar.every((entry) => isPublicLogDisabledError(entry.error))
  );
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
    const fresh = await User.findOne({ discordId });
    if (
      !ownsAutoManageDailyLease(
        fresh,
        dailyContext.targetDayKey,
        attemptCount
      )
    ) {
      return;
    }

    fresh.lastAutoManageAttemptAt = nowMs;
    if (!fresh.autoManageEnabled || fresh.localSyncEnabled) {
      releaseAutoManageDailyLeaseWithoutFinishing(
        fresh,
        AUTO_MANAGE_DAILY_OUTCOME.disabled
      );
      transition = {
        bucket: "skipped",
        outcome: AUTO_MANAGE_DAILY_OUTCOME.disabled,
      };
      await fresh.save();
      return;
    }
    if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
      releaseAutoManageDailyLeaseWithoutFinishing(
        fresh,
        AUTO_MANAGE_DAILY_OUTCOME.noRoster
      );
      transition = {
        bucket: "skipped",
        outcome: AUTO_MANAGE_DAILY_OUTCOME.noRoster,
      };
      await fresh.save();
      return;
    }

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
    nudgeStuckPrivateLogUser,
    client,
  } = deps;

  const guard = await acquireAutoManageSyncSlot(discordId);
  if (!guard.acquired) {
    return { bucket: "skipped", outcome: guard.reason || "slot-unavailable" };
  }

  let claimed = false;
  let attemptCount = 0;
  try {
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      return { bucket: "skipped", outcome: "missing-roster" };
    }
    if (!seedDoc.autoManageEnabled) {
      return { bucket: "skipped", outcome: "disabled" };
    }

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

    let latestReport = null;
    let transition = { bucket: "skipped", outcome: "superseded" };
    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (
        !ownsAutoManageDailyLease(
          fresh,
          dailyContext.targetDayKey,
          attemptCount
        )
      ) {
        return;
      }

      if (!fresh.autoManageEnabled || fresh.localSyncEnabled) {
        fresh.lastAutoManageAttemptAt = nowMs;
        releaseAutoManageDailyLeaseWithoutFinishing(
          fresh,
          AUTO_MANAGE_DAILY_OUTCOME.disabled
        );
        transition = {
          bucket: "skipped",
          outcome: AUTO_MANAGE_DAILY_OUTCOME.disabled,
        };
        await fresh.save();
        return;
      }
      if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
        fresh.lastAutoManageAttemptAt = nowMs;
        releaseAutoManageDailyLeaseWithoutFinishing(
          fresh,
          AUTO_MANAGE_DAILY_OUTCOME.noRoster
        );
        transition = {
          bucket: "skipped",
          outcome: AUTO_MANAGE_DAILY_OUTCOME.noRoster,
        };
        await fresh.save();
        return;
      }

      ensureFreshWeek(fresh);
      const report = applyAutoManageCollected(fresh, weekResetStart, collected);
      latestReport = report;
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

    if (
      shouldNudgePrivateLogUser({
        report: latestReport,
        isPublicLogDisabledError,
      })
    ) {
      try {
        await nudgeStuckPrivateLogUser(client, discordId);
      } catch (err) {
        console.warn(
          `[auto-manage daily] user ${discordId} private-log nudge failed:`,
          err?.message || err
        );
      }
    }

    return transition;
  } catch (err) {
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
  } finally {
    releaseAutoManageSyncSlot(discordId);
  }
}

function applyOutcomeCounter(counters, bucket) {
  if (bucket === "synced") counters.syncedCount += 1;
  else if (bucket === "settled") counters.settledCount += 1;
  else if (bucket === "retry-scheduled") counters.retryScheduledCount += 1;
  else if (bucket === "retry-exhausted") counters.retryExhaustedCount += 1;
  else if (bucket === "failed") counters.failedCount += 1;
  else counters.skippedCount += 1;
}

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
  nudgeStuckPrivateLogUser,
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
          nudgeStuckPrivateLogUser,
          client,
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
  AUTO_MANAGE_DAILY_TICK_MS,
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  buildAutoManageDailyCandidateQuery,
  buildAutoManageDailyClaimQuery,
  createAutoManageDailySchedulerService,
  didClaimDailyBackfill,
  shouldNudgePrivateLogUser,
  persistTransientDailyFailure,
};
