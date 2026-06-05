/**
 * handlers/raid-status/sync.js
 * Sync layer for /raid-status · runs the stale-roster refresh +
 * auto-manage piggyback inside a 2500ms budget, returning cached
 * data on timeout while the background sync continues. Background
 * apply uses a separate saveWithRetry loop so a VersionError on the
 * foreground render doesn't fan out.
 */

/**
 * Build the /raid-status sync service.
 * @param {object} deps - injected dependencies (Mongoose User +
 *   saveWithRetry, ensureFreshWeek, refresh service handles,
 *   auto-manage service handles, waitWithBudget primitive · see the
 *   destructure block).
 * @returns {object} service surface · see the return literal
 *   (loadStatusUserDoc, applyAutoManageCollectedForStatus, …)
 */
const {
  countAppliedAutoManageGates,
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
  syncRaidProfileAfterAutoManageReport,
} = require("../../services/auto-manage/reports/utils");

function createRaidStatusSync(deps) {
  const {
    User,
    saveWithRetry,
    ensureFreshWeek,
    collectStaleAccountRefreshes,
    applyStaleAccountRefreshes,
    waitWithBudget,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    applyAutoManageCollectedForStatus,
    syncRaidProfileFromBibleCollected = async () => null,
    stampAutoManageAttempt,
    weekResetStartMs,
    STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
  } = deps;

  const createOutcome = () => ({
    outcome: "not-applicable",
    newGatesApplied: 0,
  });

  const buildStatusUserMeta = (doc, outcome) => ({
    discordId: doc.discordId,
    autoManageEnabled: !!doc.autoManageEnabled,
    // Phase 5 (local-sync): surface localSyncEnabled here so /raid-status
    // can swap the bible Sync button for an "Open Web Companion" link
    // when the user is in local-sync mode. Mutex-enforced at write
    // time so both flags being true shouldn't happen, but if it does
    // local takes precedence (matches resolveSyncMode in local-sync
    // service).
    localSyncEnabled: !!doc.localSyncEnabled,
    lastAutoManageSyncAt: Number(doc.lastAutoManageSyncAt) || 0,
    lastAutoManageAttemptAt: Number(doc.lastAutoManageAttemptAt) || 0,
    lastLocalSyncAt: Number(doc.lastLocalSyncAt) || 0,
    piggybackOutcome: outcome,
  });

  async function loadStatusUserDoc(discordId, seedDoc) {
    let userDoc = null;
    let autoManageGuard = null;
    let autoManageReleaseInBackground = false;
    let profileCollected = null;
    let profileReport = null;
    let profileWeekResetStart = null;
    let shouldSyncProfile = false;
    const piggybackOutcome = createOutcome();

    try {
      ensureFreshWeek(seedDoc);

      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      const hasRoster =
        Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
      if (seedDoc.autoManageEnabled && hasRoster) {
        autoManageGuard = await acquireAutoManageSyncSlot(discordId);
        if (autoManageGuard.acquired) {
          autoManageWeekResetStart = weekResetStartMs();
          autoManagePromise = gatherAutoManageLogsForUserDoc(
            seedDoc,
            autoManageWeekResetStart
          ).catch((err) => {
            console.warn(
              "[raid-status] auto-manage piggyback gather failed:",
              err?.message || err
            );
            return null;
          });
        } else {
          piggybackOutcome.outcome = "cooldown";
        }
      }

      const [refreshCollected, autoManageBudgetResult] = await Promise.all([
        collectStaleAccountRefreshes(seedDoc),
        autoManageGuard?.acquired
          ? waitWithBudget(
              autoManagePromise,
              STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS
            )
          : Promise.resolve({ timedOut: false, value: null }),
      ]);

      let autoManageCollected = autoManageBudgetResult.value;
      const autoManageBibleHit = autoManageGuard?.acquired === true;
      const autoManageTimedOut =
        autoManageGuard?.acquired && autoManageBudgetResult.timedOut;
      const autoManageGatherFailed =
        autoManageGuard?.acquired &&
        !autoManageBudgetResult.timedOut &&
        autoManageBudgetResult.value === null;

      if (autoManageTimedOut) piggybackOutcome.outcome = "timeout";
      else if (autoManageGatherFailed) piggybackOutcome.outcome = "failed";

      if (autoManageTimedOut) {
        autoManageCollected = null;
        autoManageReleaseInBackground = true;
        autoManagePromise
          .then((backgroundCollected) =>
            applyAutoManageCollectedForStatus(
              discordId,
              autoManageWeekResetStart,
              backgroundCollected,
              "background"
            )
          )
          .catch(async (err) => {
            console.warn(
              "[raid-status] background auto-manage apply failed:",
              err?.message || err
            );
            await stampAutoManageAttempt(discordId);
          })
          .finally(() => releaseAutoManageSyncSlot(discordId));
        // Timeout itself is silent here · the `[raid-status] background
        // auto-manage finished ... outcome=...` log fired by the
        // .then handler above is the truth signal (no background log
        // implies no timeout). Keeping a second log line here just
        // amplified noise on every slow bible response.
      }

      userDoc = await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;
        profileCollected = null;
        profileReport = null;
        profileWeekResetStart = null;
        shouldSyncProfile = false;

        const didFreshenWeek = ensureFreshWeek(doc);
        const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

        let didAutoManage = false;
        if (autoManageCollected && doc.autoManageEnabled) {
          const autoReport = applyAutoManageCollected(
            doc,
            autoManageWeekResetStart,
            autoManageCollected
          );
          profileReport = autoReport;
          const now = Date.now();
          if (stampAutoManageAttemptFromReport(doc, autoReport, now)) {
            shouldSyncProfile = true;
            profileCollected = autoManageCollected;
            profileWeekResetStart = autoManageWeekResetStart;
          }
          const newGates = countAppliedAutoManageGates(autoReport);
          piggybackOutcome.newGatesApplied = newGates;
          piggybackOutcome.outcome =
            newGates > 0 ? "applied" : "synced-no-new";
          didAutoManage = true;
        } else if (autoManageBibleHit) {
          doc.lastAutoManageAttemptAt = Date.now();
          didAutoManage = true;
        }

        if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
        return toPlainUserDoc(doc);
      });
      if (shouldSyncProfile) {
        await syncRaidProfileAfterAutoManageReport({
          syncRaidProfileFromBibleCollected,
          report: profileReport,
          discordId,
          userDoc,
          weekResetStart: profileWeekResetStart,
          collected: profileCollected,
          logLabel: "[raid-status:piggyback]",
        });
      }
    } catch (err) {
      console.error("[raid-status] lazy refresh failed:", err?.message || err);
      if (autoManageGuard?.acquired) {
        await stampAutoManageAttempt(discordId);
      }
      userDoc = await User.findOne({ discordId }).lean();
    } finally {
      if (autoManageGuard?.acquired && !autoManageReleaseInBackground) {
        releaseAutoManageSyncSlot(discordId);
      }
    }

    return { userDoc, piggybackOutcome };
  }

  async function runManualStatusSync(discordId, options = {}) {
    const { onAcquired } = options;
    let manualGuard = null;
    let profileCollected = null;
    let profileReport = null;
    let profileUserDoc = null;
    let profileWeekResetStart = null;
    let shouldSyncProfile = false;
    const manualOutcome = createOutcome();

    try {
      manualGuard = await acquireAutoManageSyncSlot(discordId);
      if (!manualGuard.acquired) {
        return {
          status: "cooldown",
          outcome: manualOutcome,
          userDoc: null,
        };
      }

      if (typeof onAcquired === "function") await onAcquired();

      const weekResetStart = weekResetStartMs();
      const seedDocLocal = await User.findOne({ discordId });
      if (!seedDocLocal) {
        manualOutcome.outcome = "failed";
      } else {
        ensureFreshWeek(seedDocLocal);
        let collectedLocal = null;
        try {
          collectedLocal = await gatherAutoManageLogsForUserDoc(
            seedDocLocal,
            weekResetStart
          );
        } catch (gatherErr) {
          console.warn(
            "[raid-status manual-sync] gather failed:",
            gatherErr?.message || gatherErr
          );
          manualOutcome.outcome = "failed";
        }

        if (collectedLocal) {
          await saveWithRetry(async () => {
            const fresh = await User.findOne({ discordId });
            if (!fresh) return;
            profileCollected = null;
            profileReport = null;
            profileUserDoc = null;
            profileWeekResetStart = null;
            shouldSyncProfile = false;
            ensureFreshWeek(fresh);
            if (!fresh.autoManageEnabled) {
              fresh.lastAutoManageAttemptAt = Date.now();
              await fresh.save();
              return;
            }

            const report = applyAutoManageCollected(
              fresh,
              weekResetStart,
              collectedLocal
            );
            profileReport = report;
            const now = Date.now();
            if (stampAutoManageAttemptFromReport(fresh, report, now)) {
              shouldSyncProfile = true;
              profileCollected = collectedLocal;
              profileWeekResetStart = weekResetStart;
            }
            const newGates = countAppliedAutoManageGates(report);
            manualOutcome.newGatesApplied = newGates;
            manualOutcome.outcome =
              newGates > 0 ? "applied" : "synced-no-new";
            await fresh.save();
            profileUserDoc = toPlainUserDoc(fresh);
          });
        }
      }
    } catch (err) {
      console.error(
        "[raid-status manual-sync] unexpected error:",
        err?.message || err
      );
      manualOutcome.outcome = "failed";
      await stampAutoManageAttempt(discordId).catch(() => {});
    } finally {
      if (manualGuard?.acquired) releaseAutoManageSyncSlot(discordId);
    }

    const userDoc = await User.findOne({ discordId }).lean();
    if (shouldSyncProfile) {
      await syncRaidProfileAfterAutoManageReport({
        syncRaidProfileFromBibleCollected,
        report: profileReport,
        discordId,
        userDoc: profileUserDoc || userDoc,
        weekResetStart: profileWeekResetStart,
        collected: profileCollected,
        logLabel: "[raid-status:manual]",
      });
    }
    return {
      status: "completed",
      outcome: manualOutcome,
      userDoc,
    };
  }

  return {
    buildStatusUserMeta,
    loadStatusUserDoc,
    runManualStatusSync,
  };
}

module.exports = { createRaidStatusSync };
