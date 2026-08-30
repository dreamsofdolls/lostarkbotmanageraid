/**
 * snapshot.js
 *
 * /raid-check snapshot construction extracted from commands/raid-check.js.
 * Builds the in-memory roster classification (eligible / partial /
 * complete / not-eligible) used by every render path AND by the lazy-
 * refresh / sync flows.
 *
 * Factory pattern because the snapshot builder pulls in 15 dependencies:
 * Mongoose model, character helpers, query builder, freshness limiter,
 * lazy-refresh service. The compose root in commands/raid-check.js wires
 * them once at boot.
 */

const { t } = require("../../services/i18n");
const { isRaidCheckVisibleMode } = require("./visibility");

/**
 * Build the /raid-check snapshot helper service. Computes the pending-
 * raids snapshot that every /raid-check view (main + filter + edit
 * cascade) reads from · separated out so the per-view handlers stay
 * thin and the Mongo aggregation lives in one place.
 * @param {object} deps - injected dependencies (Mongoose User + query
 *   builder, raid catalogue, character/raid helpers · see the
 *   destructure block).
 * @returns {object} service surface · see the return literal
 */
function createSnapshotHelpers({
  // Mongoose + query
  User,
  buildRaidCheckUserQuery,
  RAID_CHECK_USER_QUERY_FIELDS,
  // Render-side constants
  UI,
  ROSTER_KEY_SEP,
  // Character / raid normalization
  toModeLabel,
  normalizeName,
  getRaidScanRange,
  ensureFreshWeek,
  ensureAssignedRaids,
  getCharacterName,
  getGateKeys,
  getGatesForRaid,
  // Lazy refresh fan-out
  raidCheckRefreshLimiter,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
}) {
  function toPlainUserDoc(userDoc) {
    if (!userDoc) return null;
    return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
  }

  function createSnapshotState() {
    return {
      userMeta: new Map(),
      rosterRefreshMap: new Map(),
      rosterRefreshAttemptMap: new Map(),
      allEligible: [],
      notEligibleChars: [],
    };
  }

  function createRaidScanContext(raidMeta) {
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    return {
      raidMeta,
      selectedDifficulty,
      selectedDiffNorm: normalizeName(selectedDifficulty),
      ...getRaidScanRange(raidMeta.raidKey, Number(raidMeta.minItemLevel) || 0),
    };
  }

  function recordUserMetadata(state, userDoc) {
    if (state.userMeta.has(userDoc.discordId)) return;
    state.userMeta.set(userDoc.discordId, {
      autoManageEnabled: !!userDoc.autoManageEnabled,
      localSyncEnabled: !!userDoc.localSyncEnabled,
      lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
      discordUsername: userDoc.discordUsername || "",
      discordGlobalName: userDoc.discordGlobalName || "",
      discordDisplayName: userDoc.discordDisplayName || "",
    });
  }

  function recordAccountFreshness(state, userDoc, account) {
    const accountName = account.accountName || "(no name)";
    const rosterKey = userDoc.discordId + ROSTER_KEY_SEP + accountName;
    state.rosterRefreshMap.set(rosterKey, Number(account.lastRefreshedAt) || 0);
    state.rosterRefreshAttemptMap.set(rosterKey, Number(account.lastRefreshAttemptAt) || 0);
    return accountName;
  }

  function buildCharacterBaseEntry(userDoc, accountName, character, assignedRaids, itemLevel) {
    return {
      discordId: userDoc.discordId,
      accountName,
      charName: getCharacterName(character),
      className: character.class || "",
      itemLevel,
      publicLogDisabled: !!character.publicLogDisabled,
      assignedRaids,
    };
  }

  function readGateProgress(assigned, officialGates, context) {
    const selectedModeDoneGates = new Set();
    const completedModeLabels = new Set();
    const gateStatus = officialGates.map((gate) => {
      const gateEntry = assigned[gate];
      if (!gateEntry || !(Number(gateEntry.completedDate) > 0)) return "pending";

      if (normalizeName(gateEntry.difficulty) === context.selectedDiffNorm) {
        selectedModeDoneGates.add(gate);
      }
      if (gateEntry.difficulty) completedModeLabels.add(toModeLabel(gateEntry.difficulty));
      return "done";
    });
    return { completedModeLabels, gateStatus, selectedModeDoneGates };
  }

  function overallGateStatus(gateStatus) {
    const doneCount = gateStatus.filter((status) => status === "done").length;
    if (doneCount === gateStatus.length) return "complete";
    if (doneCount > 0) return "partial";
    return "none";
  }

  function modeAnnotation(completedModeLabels, naturalInRange, selectedDifficulty) {
    if (completedModeLabels.size === 0) return null;
    if (completedModeLabels.has(selectedDifficulty) && naturalInRange) return null;
    return [...completedModeLabels].map((mode) => `${mode} Clear`).join("/");
  }

  function classifyCharacter(userDoc, accountName, character, context) {
    if (!character) return null;
    const itemLevel = Number(character.itemLevel) || 0;
    if (itemLevel < context.lowestMin) return null;

    const assignedRaids = ensureAssignedRaids(character);
    const assigned = assignedRaids[context.raidMeta.raidKey] || {};
    const storedModeKey = assigned.modeKey || assigned.G1?.difficulty || assigned.G2?.difficulty || "";
    if (!isRaidCheckVisibleMode(storedModeKey)) return null;

    const baseEntry = buildCharacterBaseEntry(
      userDoc,
      accountName,
      character,
      assignedRaids,
      itemLevel
    );
    const storedGateKeys = getGateKeys(assigned);
    const officialGates = storedGateKeys.length > 0
      ? storedGateKeys
      : getGatesForRaid(context.raidMeta.raidKey);
    const naturalInRange = itemLevel >= context.selfMin && itemLevel < context.nextMin;
    const progress = readGateProgress(assigned, officialGates, context);
    if (!naturalInRange && progress.selectedModeDoneGates.size === 0) {
      return {
        bucket: "notEligibleChars",
        entry: {
          ...baseEntry,
          gateStatus: [],
          overallStatus: "not-eligible",
          notEligibleReason: itemLevel < context.selfMin ? "low" : "high",
        },
      };
    }

    return {
      bucket: "allEligible",
      entry: {
        ...baseEntry,
        gateStatus: progress.gateStatus,
        overallStatus: overallGateStatus(progress.gateStatus),
        doneModeAnnotation: modeAnnotation(
          progress.completedModeLabels,
          naturalInRange,
          context.selectedDifficulty
        ),
      },
    };
  }

  function collectAccountCharacters(state, userDoc, account, context) {
    const accountName = recordAccountFreshness(state, userDoc, account);
    const characters = Array.isArray(account.characters) ? account.characters : [];
    for (const character of characters) {
      const classified = classifyCharacter(userDoc, accountName, character, context);
      if (classified) state[classified.bucket].push(classified.entry);
    }
  }

  function finalizeSnapshotState(state) {
    const completeChars = state.allEligible.filter((char) => char.overallStatus === "complete");
    const partialChars = state.allEligible.filter((char) => char.overallStatus === "partial");
    const noneChars = state.allEligible.filter((char) => char.overallStatus === "none");
    return {
      ...state,
      allChars: [...state.allEligible, ...state.notEligibleChars],
      completeChars,
      partialChars,
      noneChars,
      pendingChars: [...partialChars, ...noneChars],
    };
  }

  function buildRaidCheckSnapshotFromUsers(users, raidMeta) {
    const state = createSnapshotState();
    const context = createRaidScanContext(raidMeta);

    for (const userDoc of users || []) {
      if (!userDoc) continue;
      ensureFreshWeek(userDoc);
      recordUserMetadata(state, userDoc);
      const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      for (const account of accounts) collectAccountCharacters(state, userDoc, account, context);
    }
    return finalizeSnapshotState(state);
  }

  function formatRaidCheckNotEligibleFieldValue(character, lang = "vi") {
    if (character?.notEligibleReason === "low") {
      return `${UI.icons.lock} ${t("raid-check.snapshot.notEligibleLow", lang)}`;
    }
    if (character?.notEligibleReason === "high") {
      return `${UI.icons.lock} ${t("raid-check.snapshot.notEligibleHigh", lang)}`;
    }
    return `${UI.icons.lock} ${t("raid-check.snapshot.notEligibleGeneric", lang)}`;
  }

  function getRaidCheckRenderableChars(snapshot) {
    return Array.isArray(snapshot?.allEligible) ? [...snapshot.allEligible] : [];
  }

  async function computeRaidCheckSnapshot(raidMeta, { syncFreshData = false } = {}) {
    const started = Date.now();
    const userQuery = buildRaidCheckUserQuery(raidMeta);
    const raidLabel = `${raidMeta?.raidKey || "unknown"}:${raidMeta?.modeKey || "unknown"}`;
    const logSnapshot = (extra) => {
      const parts = Object.entries(extra)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      console.log(
        `[raid-check] snapshot raid=${raidLabel} syncFreshData=${syncFreshData} ${parts} totalMs=${Date.now() - started}`
      );
    };

    if (!syncFreshData) {
      const queryStarted = Date.now();
      const users = await User.find(userQuery)
        .select(RAID_CHECK_USER_QUERY_FIELDS)
        .lean();
      const queryMs = Date.now() - queryStarted;
      const snapshot = buildRaidCheckSnapshotFromUsers(users, raidMeta);
      logSnapshot({
        users: users.length,
        allChars: snapshot.allChars.length,
        pending: snapshot.pendingChars.length,
        queryMs,
      });
      return snapshot;
    }

    const queryStarted = Date.now();
    const seedUsers = await User.find(userQuery).select(RAID_CHECK_USER_QUERY_FIELDS);
    const queryMs = Date.now() - queryStarted;
    const refreshStarted = Date.now();
    let refreshQueued = 0;
    let freshBypass = 0;
    const users = await Promise.all(
      seedUsers.map((seedDoc) => {
        const shouldRefresh =
          typeof shouldLoadFreshUserSnapshotForRaidViews === "function"
            ? shouldLoadFreshUserSnapshotForRaidViews(seedDoc, {
                allowAutoManage: false,
              })
            : true;
        if (!shouldRefresh) {
          freshBypass += 1;
          return Promise.resolve(toPlainUserDoc(seedDoc));
        }
        refreshQueued += 1;
        return raidCheckRefreshLimiter.run(() =>
          loadFreshUserSnapshotForRaidViews(seedDoc, {
            allowAutoManage: false,
            logLabel: "[raid-check]",
          })
        );
      })
    );
    const refreshMs = Date.now() - refreshStarted;
    const snapshot = buildRaidCheckSnapshotFromUsers(users, raidMeta);
    logSnapshot({
      users: seedUsers.length,
      freshUsers: users.filter(Boolean).length,
      refreshQueued,
      freshBypass,
      allChars: snapshot.allChars.length,
      pending: snapshot.pendingChars.length,
      queryMs,
      refreshMs,
    });
    return snapshot;
  }

  return {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
  };
}

module.exports = { createSnapshotHelpers };
