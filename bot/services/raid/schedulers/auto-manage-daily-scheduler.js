"use strict";

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
  deferAutoManageDailyAttempt,
  releaseAutoManageDailyLeaseWithoutFinishing,
} = require("../../auto-manage/runtime/support/daily-state");
const {
  BIBLE_ERROR_KIND,
  classifyBibleError,
  createBibleCharacterNotFoundError,
} = require("../../auto-manage/bible/error-kinds");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const { normalizeName } = require("../../../utils/raid/common/shared");

// Calendar settlement limits each user to one completed run per VN day.
// Short ticks drain due users in small batches through the shared Bible limiter.
const AUTO_MANAGE_DAILY_TICK_MS = 5 * 60 * 1000;
const AUTO_MANAGE_DAILY_BATCH_SIZE = 6;
// Every roster refreshes in the minutes after midnight. Back-to-back requests
// tripped Bible's 429, whose backoff blocks every Bible feature for 1-5 min.
const DAILY_ROSTER_REFRESH_GAP_MS = 1500;
const OUTCOME_COUNTER_KEY_BY_BUCKET = new Map([
  ["synced", "syncedCount"],
  ["settled", "settledCount"],
  ["retry-scheduled", "retryScheduledCount"],
  ["retry-exhausted", "retryExhaustedCount"],
  ["failed", "failedCount"],
]);

/**
 * @param {object} dailyContext - Target VN calendar day.
 * @param {number} [nowMs] - Eligibility clock.
 * @returns {object} Due registered users.
 */
function buildAutoManageDailyCandidateQuery(dailyContext, nowMs = Date.now()) {
  return {
    "accounts.0": { $exists: true },
    ...buildAutoManageDailyAvailabilityFilter(dailyContext, nowMs),
  };
}

/**
 * @param {string} discordId - Roster owner.
 * @param {object} dailyContext - Target VN calendar day.
 * @param {number} [nowMs] - Eligibility clock.
 * @returns {object} Atomic claim filter.
 */
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

function dailyRosterBoundaryMs(dailyContext) {
  return Date.parse(`${dailyContext.currentDayKey}T00:00:00+07:00`);
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
  leaseToken,
  nowMs,
  bibleAttempted,
}) {
  if (!ownsAutoManageDailyLease(userDoc, targetDayKey, attemptCount, leaseToken)) {
    return {
      handled: true,
      transition: { bucket: "skipped", outcome: "superseded" },
    };
  }

  if (bibleAttempted) userDoc.lastAutoManageAttemptAt = nowMs;
  let outcome = null;
  if (!Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    outcome = AUTO_MANAGE_DAILY_OUTCOME.noRoster;
  }
  if (!outcome) return { handled: false, transition: null };

  userDoc.lastDailyRosterAttemptAt = nowMs;
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
  leaseToken,
  nowMs,
  bibleAttempted,
}) {
  const fresh = await User.findOne({ discordId });
  const settlement = await settleUnavailableDailyCandidate({
    userDoc: fresh,
    targetDayKey: dailyContext.targetDayKey,
    attemptCount,
    leaseToken,
    nowMs,
    bibleAttempted,
  });
  return { fresh, settlement };
}

/**
 * Save bounded retry state while the failed worker still owns its lease.
 * @param {object} options - Persistence, attempt identity and actual Bible usage.
 * @returns {Promise<object>} Persisted retry transition or superseded result.
 */
async function persistTransientDailyFailure({
  User,
  saveWithRetry,
  discordId,
  dailyContext,
  attemptCount,
  leaseToken,
  nowMs,
  bibleAttempted = false,
}) {
  let transition = { bucket: "skipped", outcome: "superseded" };
  await saveWithRetry(async () => {
    const { fresh, settlement } = await loadDailyCandidateSettlement({
      User,
      discordId,
      dailyContext,
      attemptCount,
      leaseToken,
      nowMs,
      bibleAttempted,
    });
    if (settlement.handled) {
      transition = settlement.transition;
      return;
    }

    fresh.lastDailyRosterAttemptAt = nowMs;
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
  return { seedDoc, transition: null };
}

async function persistCollectedDailyReport({
  User,
  saveWithRetry,
  discordId,
  dailyContext,
  attemptCount,
  leaseToken,
  nowMs,
  ensureFreshWeek,
  applyAutoManageCollected,
  weekResetStart,
  collected,
  refreshCollected,
  applyStaleAccountRefreshes,
}) {
  let report = null;
  let transition = { bucket: "skipped", outcome: "superseded" };
  await saveWithRetry(async () => {
    const { fresh, settlement } = await loadDailyCandidateSettlement({
      User,
      discordId,
      dailyContext,
      attemptCount,
      leaseToken,
      nowMs,
      bibleAttempted: collected !== null,
    });
    if (settlement.handled) {
      transition = settlement.transition;
      return;
    }

    ensureFreshWeek(fresh);
    const refreshBoundary = dailyRosterBoundaryMs(dailyContext);
    const refreshedAccounts = fresh.accounts.filter(account => account.characters?.length > 0);
    const accountsByName = new Map(fresh.accounts.map(account => [normalizeName(account.accountName), account]));
    // A manual/view refresh can finish while Bible gathering is in flight.
    // Its newer metadata wins over this day's earlier collection.
    const dueRefreshes = refreshCollected.filter(entry => {
      const account = accountsByName.get(normalizeName(entry?.accountName));
      return account && !(Number(account.lastRefreshedAt) >= refreshBoundary);
    });
    const bibleAllowed = collected !== null && fresh.autoManageEnabled && !fresh.localSyncEnabled;
    // Gather keys contain the saved account/character names. Apply their logs
    // before the metadata merge can rename that account or character.
    report = bibleAllowed
      ? applyAutoManageCollected(fresh, weekResetStart, collected)
      : { perChar: [] };
    applyStaleAccountRefreshes(fresh, dueRefreshes);
    const failureKindByName = new Map(refreshCollected
      .filter(entry => entry?.accountName)
      .map(entry => [normalizeName(entry.accountName), entry.failureKind]));
    // A not-found error settles the day the way a missing character does in
    // the clear-log report; any other refresh failure is worth a retry.
    const refreshEntries = refreshedAccounts.map(account => {
      if (Number(account.lastRefreshedAt) >= refreshBoundary) return { error: null };
      return failureKindByName.get(normalizeName(account.accountName)) === BIBLE_ERROR_KIND.notFound
        ? { error: createBibleCharacterNotFoundError(account.accountName).message }
        : { error: `Roster refresh unavailable: ${account.accountName}` };
    });
    const dailyReport = {
      perChar: bibleAllowed
        ? [...report.perChar, ...refreshEntries.filter(entry => entry.error)]
        : refreshEntries,
    };
    const rateLimited = refreshCollected.some(entry => entry?.failureKind === BIBLE_ERROR_KIND.rateLimit)
      || dailyReport.perChar.some(entry => entry.error && classifyBibleError(entry.error) === BIBLE_ERROR_KIND.rateLimit);
    transition = rateLimited
      ? deferAutoManageDailyAttempt(fresh, attemptCount)
      : applyAutoManageDailyReportState({
        userDoc: fresh,
        report: dailyReport,
        targetDayKey: dailyContext.targetDayKey,
        attemptCount,
        nowMs,
      });
    fresh.lastDailyRosterAttemptAt = nowMs;
    if (bibleAllowed && transition.outcome === AUTO_MANAGE_DAILY_OUTCOME.success) {
      fresh.lastAutoManageSyncAt = nowMs;
    }
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
  leaseToken,
  nowMs,
  bibleAttempted,
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
        leaseToken,
        nowMs,
        bibleAttempted,
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
    collectAccountRefresh,
    applyStaleAccountRefreshes,
    waitFn,
  } = deps;

  const guard = await acquireAutoManageSyncSlot(discordId);
  if (!guard.acquired) {
    return { bucket: "skipped", outcome: guard.reason || "slot-unavailable" };
  }

  let claimed = false;
  let attemptCount = 0;
  let leaseToken = "";
  let bibleAttempted = false;
  try {
    const seed = await loadEligibleDailySeed(User, discordId);
    if (seed.transition) return seed.transition;
    const { seedDoc } = seed;

    attemptCount = getNextAutoManageDailyAttemptCount(
      seedDoc,
      dailyContext.targetDayKey
    );
    const claimUpdate = buildAutoManageDailyClaimUpdate({ targetDayKey: dailyContext.targetDayKey, attemptCount, nowMs });
    leaseToken = claimUpdate.$set.autoManageDailyLeaseToken;
    const claim = await User.updateOne(
      buildAutoManageDailyClaimQuery(discordId, dailyContext, nowMs), claimUpdate
    );
    if (!didClaimDailyBackfill(claim)) {
      return { bucket: "skipped", outcome: "claimed-or-not-due" };
    }
    claimed = true;

    ensureFreshWeek(seedDoc);
    const refreshCollected = [];
    const refreshBoundary = dailyRosterBoundaryMs(dailyContext);
    for (const account of seedDoc.accounts) {
      if (account.characters?.length > 0 && !(Number(account.lastRefreshedAt) >= refreshBoundary)) {
        await waitFn(DAILY_ROSTER_REFRESH_GAP_MS);
        const refreshed = await collectAccountRefresh(seedDoc, account.accountName);
        refreshCollected.push(refreshed);
        // The backoff a 429 opens would refuse every later request.
        if (refreshed?.failureKind === BIBLE_ERROR_KIND.rateLimit) break;
      }
    }
    const rateLimited = refreshCollected.at(-1)?.failureKind === BIBLE_ERROR_KIND.rateLimit;
    bibleAttempted = !rateLimited && seedDoc.autoManageEnabled && !seedDoc.localSyncEnabled;
    const collected = bibleAttempted
      ? await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart)
      : null;

    const persisted = await persistCollectedDailyReport({
      User,
      saveWithRetry,
      discordId,
      dailyContext,
      attemptCount,
      leaseToken,
      nowMs,
      ensureFreshWeek,
      applyAutoManageCollected,
      weekResetStart,
      collected,
      refreshCollected,
      applyStaleAccountRefreshes,
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
      leaseToken,
      nowMs,
      bibleAttempted,
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
 * Refresh every registered roster each VN day and reconcile Bible clear logs
 * for opted-in users, with bounded retries and a completion announcement.
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
  collectAccountRefresh,
  applyStaleAccountRefreshes,
  notifyDailyRosterSync = null,
  getBibleBackoffRemainingMs = () => 0,
  waitFn = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
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
      .sort({ lastDailyRosterAttemptAt: 1 })
      .limit(AUTO_MANAGE_DAILY_BATCH_SIZE)
      .select("discordId")
      .lean();

    const counters = createOutcomeCounters();
    const weekResetStart = weekResetStartMs();
    for (const [index, { discordId }] of candidates.entries()) {
      // The backoff refuses every Bible request, so starting a roster now
      // would only fail it; the rest of the batch waits for a later tick.
      if (getBibleBackoffRemainingMs() > 0) {
        console.warn(`[auto-manage daily] Bible backoff active - ${candidates.length - index} candidate(s) wait for the next tick`);
        break;
      }
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
          collectAccountRefresh,
          applyStaleAccountRefreshes,
          waitFn,
        },
      });
      applyOutcomeCounter(counters, outcome.bucket);
    }

    if (candidates.length > 0) {
      console.log(
        `[auto-manage daily] target=${dailyContext.targetDayKey}: ${candidates.length} candidate(s) | synced ${counters.syncedCount} | settled ${counters.settledCount} | retry ${counters.retryScheduledCount} | exhausted ${counters.retryExhaustedCount} | skipped ${counters.skippedCount} | failed ${counters.failedCount}`
      );
    }
    if (notifyDailyRosterSync) await notifyDailyRosterSync(client, dailyContext);
  }

  const autoManageDailyRunner = createNonOverlappingIntervalRunner({
    tickMs: AUTO_MANAGE_DAILY_TICK_MS,
    alignToClock: true,
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
  DAILY_ROSTER_REFRESH_GAP_MS,
  buildAutoManageDailyCandidateQuery,
  buildAutoManageDailyClaimQuery,
  applyOutcomeCounter,
  createOutcomeCounters,
  createAutoManageDailySchedulerService,
  persistTransientDailyFailure,
};
