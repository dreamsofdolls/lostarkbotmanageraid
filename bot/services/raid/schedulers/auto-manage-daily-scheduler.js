"use strict";

const {
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
  syncRaidProfileAfterAutoManageReport,
} = require("../../auto-manage/reports/utils");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");

const AUTO_MANAGE_DAILY_TICK_MS = 30 * 60 * 1000;
const AUTO_MANAGE_DAILY_CUTOFF_MS = 24 * 60 * 60 * 1000;
const AUTO_MANAGE_DAILY_BATCH_SIZE = 3;

function buildAutoManageDailyCandidateQuery(cutoff) {
  return {
    autoManageEnabled: true,
    "accounts.0": { $exists: true },
    $or: [
      { lastAutoManageSyncAt: null },
      { lastAutoManageSyncAt: { $lt: cutoff } },
    ],
  };
}

function createOutcomeCounters() {
  return {
    syncedCount: 0,
    attemptedOnlyCount: 0,
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

async function syncCandidate({
  discordId,
  weekResetStart,
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
    syncRaidProfileFromBibleCollected,
    isPublicLogDisabledError,
    stampAutoManageAttempt,
    nudgeStuckPrivateLogUser,
    client,
  } = deps;

  const guard = await acquireAutoManageSyncSlot(discordId);
  if (!guard.acquired) {
    return { bucket: "skipped" };
  }

  let bibleHit = false;
  try {
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      return { bucket: "skipped" };
    }
    if (!seedDoc.autoManageEnabled) {
      return { bucket: "skipped" };
    }

    ensureFreshWeek(seedDoc);
    const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
    bibleHit = true;

    let outcome = "attempted-only";
    let latestReport = null;
    let profileUserDoc = null;
    let profileReport = null;
    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;
      profileUserDoc = null;
      profileReport = null;
      ensureFreshWeek(fresh);
      if (!fresh.autoManageEnabled) {
        fresh.lastAutoManageAttemptAt = Date.now();
        await fresh.save();
        return;
      }
      const report = applyAutoManageCollected(fresh, weekResetStart, collected);
      latestReport = report;
      profileReport = report;
      const now = Date.now();
      if (stampAutoManageAttemptFromReport(fresh, report, now)) {
        outcome = "synced";
      }
      await fresh.save();
      profileUserDoc = toPlainUserDoc(fresh);
    });

    await syncRaidProfileAfterAutoManageReport({
      syncRaidProfileFromBibleCollected,
      report: profileReport,
      discordId,
      userDoc: profileUserDoc,
      weekResetStart,
      collected,
      logLabel: "[auto-manage daily]",
    });

    if (
      shouldNudgePrivateLogUser({
        report: latestReport,
        isPublicLogDisabledError,
      })
    ) {
      await nudgeStuckPrivateLogUser(client, discordId);
    }

    return { bucket: outcome === "synced" ? "synced" : "attempted-only" };
  } catch (err) {
    if (bibleHit) {
      await stampAutoManageAttempt(discordId);
    }
    console.warn(
      `[auto-manage daily] user ${discordId} sync failed:`,
      err?.message || err
    );
    return { bucket: "failed" };
  } finally {
    releaseAutoManageSyncSlot(discordId);
  }
}

function applyOutcomeCounter(counters, bucket) {
  if (bucket === "synced") counters.syncedCount += 1;
  else if (bucket === "attempted-only") counters.attemptedOnlyCount += 1;
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
  syncRaidProfileFromBibleCollected = async () => null,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
  nudgeStuckPrivateLogUser,
  processEnv = process.env,
}) {
  async function runAutoManageDailyTick(client) {
    if (processEnv.AUTO_MANAGE_DAILY_DISABLED === "true") return;

    const cutoff = Date.now() - AUTO_MANAGE_DAILY_CUTOFF_MS;
    const candidates = await User.find(buildAutoManageDailyCandidateQuery(cutoff))
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
        deps: {
          User,
          saveWithRetry,
          ensureFreshWeek,
          acquireAutoManageSyncSlot,
          releaseAutoManageSyncSlot,
          gatherAutoManageLogsForUserDoc,
          applyAutoManageCollected,
          syncRaidProfileFromBibleCollected,
          isPublicLogDisabledError,
          stampAutoManageAttempt,
          nudgeStuckPrivateLogUser,
          client,
        },
      });
      applyOutcomeCounter(counters, outcome.bucket);
    }

    console.log(
      `[auto-manage daily] tick: ${candidates.length} candidate(s) · synced ${counters.syncedCount} · attempted-only ${counters.attemptedOnlyCount} · skipped ${counters.skippedCount} · failed ${counters.failedCount}`
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
  AUTO_MANAGE_DAILY_CUTOFF_MS,
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  buildAutoManageDailyCandidateQuery,
  createAutoManageDailySchedulerService,
  shouldNudgePrivateLogUser,
};
