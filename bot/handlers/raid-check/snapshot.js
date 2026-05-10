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

  function buildRaidCheckSnapshotFromUsers(users, raidMeta) {
    const userMeta = new Map();
    const rosterRefreshMap = new Map();
    const rosterRefreshAttemptMap = new Map();
    const allEligible = [];
    const notEligibleChars = [];
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    const selectedDiffNorm = normalizeName(selectedDifficulty);
    const { lowestMin, selfMin, nextMin } = getRaidScanRange(
      raidMeta.raidKey,
      Number(raidMeta.minItemLevel) || 0
    );

    for (const userDoc of users || []) {
      if (!userDoc) continue;
      ensureFreshWeek(userDoc);
      if (!userMeta.has(userDoc.discordId)) {
        userMeta.set(userDoc.discordId, {
          autoManageEnabled: !!userDoc.autoManageEnabled,
          localSyncEnabled: !!userDoc.localSyncEnabled,
          lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
          lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
          // Cached Discord identity strings from the User doc. The Edit
          // flow prefers these (populated the last time the user ran a
          // slash command) over a live client.users.fetch round-trip
          // because discord.js's cached user often only has the raw
          // username handle, not the guild-displayed nickname.
          discordUsername: userDoc.discordUsername || "",
          discordGlobalName: userDoc.discordGlobalName || "",
          discordDisplayName: userDoc.discordDisplayName || "",
        });
      }

      const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      for (const account of accounts) {
        const rosterKey = userDoc.discordId + ROSTER_KEY_SEP + (account.accountName || "(no name)");
        rosterRefreshMap.set(rosterKey, Number(account.lastRefreshedAt) || 0);
        rosterRefreshAttemptMap.set(rosterKey, Number(account.lastRefreshAttemptAt) || 0);

        const characters = Array.isArray(account.characters) ? account.characters : [];
        for (const character of characters) {
          if (!character) continue;
          const characterItemLevel = Number(character.itemLevel) || 0;
          if (characterItemLevel < lowestMin) continue;

          const assignedRaids = ensureAssignedRaids(character);
          const baseEntry = {
            discordId: userDoc.discordId,
            accountName: account.accountName || "(no name)",
            charName: getCharacterName(character),
            // Carried so the user-filter dropdown can show a per-user
            // support/DPS breakdown ("8 pending · 2🛡️ 6⚔️"). Without
            // this the dropdown only knows the total, which makes it
            // hard to tell whether a backlog is composition-blocking
            // (low support count) or just queue depth.
            className: character.class || "",
            itemLevel: characterItemLevel,
            // Carried forward so the /raid-check Edit flow can decide
            // whether a leader is allowed to touch this char despite the
            // owner having auto-sync enabled - see the Edit-flow auth
            // rule in services/access/manager-edit-auth or the cascading
            // select builders.
            publicLogDisabled: !!character.publicLogDisabled,
            // Full assignedRaids copy so the Edit flow can show per-gate
            // state for ANY raid the leader picks in the raid dropdown,
            // not just the scanned raidMeta. Without this the cascading
            // select would render "Complete / Process / Reset" with no
            // indication of what's already done, and Complete on an
            // already-done raid would silently no-op server-side after a
            // confusing click. Keeping the whole tree is cheap - each
            // character has at most 3 raids × 2-3 gates.
            assignedRaids,
          };

          const assigned = assignedRaids[raidMeta.raidKey] || {};
          const storedGateKeys = getGateKeys(assigned);
          const officialGates =
            storedGateKeys.length > 0 ? storedGateKeys : getGatesForRaid(raidMeta.raidKey);
          const naturalInRange =
            characterItemLevel >= selfMin && characterItemLevel < nextMin;
          const selectedModeDoneGates = new Set();
          const completedModeLabels = new Set();
          const gateStatus = officialGates.map((gate) => {
            const gateEntry = assigned[gate];
            if (!gateEntry) return "pending";
            if (!(Number(gateEntry.completedDate) > 0)) return "pending";

            const storedDiffNorm = normalizeName(gateEntry.difficulty);
            if (storedDiffNorm === selectedDiffNorm) selectedModeDoneGates.add(gate);
            if (gateEntry.difficulty) completedModeLabels.add(toModeLabel(gateEntry.difficulty));
            return "done";
          });

          const doneCount = gateStatus.filter((status) => status === "done").length;
          let overallStatus;
          if (doneCount === officialGates.length) overallStatus = "complete";
          else if (doneCount > 0) overallStatus = "partial";
          else overallStatus = "none";

          // Mode placement has two sources:
          //   1. natural bucket by current iLvl range (default planning view)
          //   2. explicit progress at the selected mode (what they actually ran)
          //
          // Example: a 1740 Serca character naturally belongs to Nightmare.
          // If they actually clear Serca Normal, show them in BOTH the
          // Nightmare bucket (with "Normal Clear") and the Normal page (because
          // that page is the source-of-truth view for Normal clears). But a
          // 1730+ character with Hard progress should not leak into Normal just
          // because Hard ranks above Normal.
          const hasSelectedModeProgress = selectedModeDoneGates.size > 0;
          if (!naturalInRange && !hasSelectedModeProgress) {
            notEligibleChars.push({
              ...baseEntry,
              gateStatus: [],
              overallStatus: "not-eligible",
              notEligibleReason: characterItemLevel < selfMin ? "low" : "high",
            });
            continue;
          }

          // Annotation for clears whose actual mode is important context:
          // different mode than the scan, or an out-of-range same-mode clear
          // surfaced by explicit progress instead of the natural iLvl bucket.
          const doneModeAnnotation =
            completedModeLabels.size > 0 &&
            (!completedModeLabels.has(selectedDifficulty) || !naturalInRange)
              ? [...completedModeLabels].map((mode) => `${mode} Clear`).join("/")
              : null;

          allEligible.push({
            ...baseEntry,
            gateStatus,
            overallStatus,
            doneModeAnnotation,
          });
        }
      }
    }

    const completeChars = allEligible.filter((c) => c.overallStatus === "complete");
    const partialChars = allEligible.filter((c) => c.overallStatus === "partial");
    const noneChars = allEligible.filter((c) => c.overallStatus === "none");
    const pendingChars = [...partialChars, ...noneChars];
    const allChars = [...allEligible, ...notEligibleChars];

    return {
      allEligible,
      allChars,
      completeChars,
      partialChars,
      noneChars,
      notEligibleChars,
      pendingChars,
      userMeta,
      rosterRefreshMap,
      rosterRefreshAttemptMap,
    };
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
