/**
 * handlers/raid-status/sync/sync.js
 * Sync layer for /raid-status. The root handler renders a weekly-fresh
 * snapshot first, then starts stale-roster refresh + auto-manage piggyback
 * here in the background. Apply uses a separate saveWithRetry loop so a
 * VersionError cannot fan out across the visible session.
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
  getAutoManageEntries,
  hasSuccessfulAutoManageReport,
  toPlainUserDoc,
} = require("../../../services/auto-manage/reports/utils");
const {
  AUTO_MANAGE_STATUS_STALE_MS,
  isAutoManageAttemptStale,
} = require("../../../services/auto-manage/runtime/support/freshness");
const { isPublicLogDisabledError } = require("../../../services/auto-manage/bible/error-kinds");
const {
  commitCollectedRaidViewRefresh,
} = require("../../../services/raid/view-refresh-commit");

const STATUS_AUTO_MANAGE_PIGGYBACK_STALE_MS = AUTO_MANAGE_STATUS_STALE_MS;

// A report with no successful entry and at least one Bible failure (outage,
// 429) synced nothing. An empty report, or one whose only errors are private
// logs ("Logs not enabled"), is the user's own setting, not a failed sync.
function autoManageReportOutcome(report) {
  const newGatesApplied = countAppliedAutoManageGates(report);
  const hasBibleFailure = getAutoManageEntries(report)
    .some((entry) => entry?.error && !isPublicLogDisabledError(entry.error));
  if (hasBibleFailure && !hasSuccessfulAutoManageReport(report)) {
    return { outcome: "failed", newGatesApplied };
  }
  return { outcome: newGatesApplied > 0 ? "applied" : "synced-no-new", newGatesApplied };
}

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
    commitAutoManageCollected,
    applyAutoManageCollectedForStatus,
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
    // Surface localSyncEnabled so /raid-status can swap the bible Sync
    // button for an "Open Web Companion" link
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

  const cloneRenderSnapshot = (seedDoc) => {
    const plain = toPlainUserDoc(seedDoc);
    if (!plain || plain !== seedDoc) return plain;

    const clone = (value) => {
      if (Array.isArray(value)) return value.map(clone);
      if (!value || typeof value !== "object" || value instanceof Date) return value;
      if (Object.getPrototypeOf(value) !== Object.prototype) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, clone(entry)])
      );
    };
    return clone(plain);
  };

  function prepareStatusUserDoc(discordId, seedDoc) {
    const userDoc = cloneRenderSnapshot(seedDoc);
    ensureFreshWeek(userDoc);

    let backgroundRefreshPromise = null;
    const startBackgroundRefresh = () => {
      if (!backgroundRefreshPromise) {
        backgroundRefreshPromise = loadStatusUserDoc(discordId, seedDoc);
      }
      return backgroundRefreshPromise;
    };

    return {
      userDoc,
      piggybackOutcome: createOutcome(),
      startBackgroundRefresh,
    };
  }

  async function loadStatusUserDoc(discordId, seedDoc) {
    let userDoc;
    let backgroundSyncPromise = null;
    let autoManageGuard = null;
    let autoManageReleaseInBackground = false;
    const piggybackOutcome = createOutcome();

    try {
      const didFreshenSeedWeek = ensureFreshWeek(seedDoc);

      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      const hasRoster =
        Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
      if (
        seedDoc.autoManageEnabled &&
        hasRoster &&
        isAutoManageAttemptStale(seedDoc, {
          staleMs: STATUS_AUTO_MANAGE_PIGGYBACK_STALE_MS,
        })
      ) {
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
        backgroundSyncPromise = autoManagePromise
          .then(async (backgroundCollected) => {
            const snapshot = await applyAutoManageCollectedForStatus(
              discordId,
              autoManageWeekResetStart,
              backgroundCollected,
              "background"
            );
            piggybackOutcome.outcome = backgroundCollected ? "not-applicable" : "failed";
            return snapshot;
          })
          .catch(async (err) => {
            piggybackOutcome.outcome = "failed";
            console.warn(
              "[raid-status] background auto-manage apply failed:",
              err?.message || err
            );
            await stampAutoManageAttempt(discordId);
          })
          .finally(() => releaseAutoManageSyncSlot(discordId));
        // Keep the slot through persistence and expose completion so the
        // open card can reload after work that outlives the initial budget.
      }

      const hasCollectedRefresh =
        Array.isArray(refreshCollected) && refreshCollected.length > 0;
      // The common read-only path can render from the seed snapshot. Enter the
      // retry loop only when this request has state that may need persistence.
      const needsFreshWrite =
        didFreshenSeedWeek || hasCollectedRefresh || autoManageBibleHit;
      if (!needsFreshWrite) {
        userDoc = toPlainUserDoc(seedDoc);
      } else {
        userDoc = await commitCollectedRaidViewRefresh({
          User,
          saveWithRetry,
          discordId,
          ensureFreshWeek,
          applyStaleAccountRefreshes,
          refreshCollected,
          applyAutoManageCollected,
          autoManageCollected,
          autoManageWeekResetStart,
          autoManageBibleHit,
          onAutoManageReport: (autoReport) => {
            Object.assign(piggybackOutcome, autoManageReportOutcome(autoReport));
          },
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

    return { userDoc, piggybackOutcome, backgroundSyncPromise };
  }

  async function runManualStatusSync(discordId, options = {}) {
    const { onAcquired } = options;
    let manualGuard = null;
    let committedSnapshot = null;
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
          const committed = await commitAutoManageCollected(
            discordId,
            weekResetStart,
            collectedLocal
          );
          committedSnapshot = committed?.snapshot || null;
          if (committed?.report) {
            Object.assign(manualOutcome, autoManageReportOutcome(committed.report));
          }
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

    const userDoc = committedSnapshot || await User.findOne({ discordId }).lean();
    return {
      status: "completed",
      outcome: manualOutcome,
      userDoc,
    };
  }

  return {
    buildStatusUserMeta,
    loadStatusUserDoc,
    prepareStatusUserDoc,
    runManualStatusSync,
  };
}

module.exports = { createRaidStatusSync };
