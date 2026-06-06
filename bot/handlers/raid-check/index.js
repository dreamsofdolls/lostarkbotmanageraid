/**
 * handlers/raid-check/index.js
 * Compose root for /raid-check (Manager-only cross-raid overview).
 * Wires the snapshot helpers + edit cascade + sync flow + all-mode
 * + auto-manage UI + task-view UI into one handler bag dispatched
 * from commands.js. Owns the per-session pagination timer.
 *
 * Composition order matters: sync-ui must come BEFORE edit-ui
 * because edit-ui consumes resolveCachedDisplayName as a dep.
 */

const { createSnapshotHelpers } = require("./snapshot");
const { createEditHelpers } = require("./edit/edit-helpers");
const { createAllModeHandler } = require("./all-mode/all-mode");
const { createEditUi } = require("./edit/edit-ui");
const { createSyncUi } = require("./views/sync-ui");
const {
  createRaidCheckAutoManageUi,
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
} = require("./auto-manage/auto-manage");
const { createTaskViewUi } = require("./views/task-view-ui");
const { buildNoticeEmbed, replyNotice } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  RAID_CHECK_BUTTON_HANDLER,
  RAID_CHECK_BUTTON_SCOPE,
  getRaidCheckButtonRoute,
} = require("./button-routes");

const RAID_CHECK_PAGINATION_SESSION_MS = 5 * 60 * 1000;

/**
 * Build the /raid-check command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   MessageFlags, Mongoose User + saveWithRetry, raid catalogue,
 *   auto-manage service handles, raidCheckRefreshLimiter +
 *   raidCheckSyncLimiter + discordUserLimiter, RAID_REQUIREMENT_MAP
 *   · see the destructure block).
 * @returns {object} service surface · see the return literal for the
 *   canonical handler list (handleRaidCheckCommand + every button /
 *   select dispatch entry for the all-mode, edit cascade, sync flow,
 *   auto-manage UI, and task view).
 */
function createRaidCheckCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    toModeLabel,
    getCharacterName,
    truncateText,
    getGatesForRaid,
    ensureAssignedRaids,
    getGateKeys,
    getRaidScanRange,
    buildRaidCheckUserQuery,
    buildAccountPageEmbed,
    buildStatusFooterText,
    summarizeRaidProgress,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    resolveDiscordDisplay,
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    syncRaidProfileFromBibleCollected,
    stampAutoManageAttempt,
    weekResetStartMs,
    isRaidLeader,
    isManagerId,
    applyRaidSetForDiscordId,
    RAID_REQUIREMENT_MAP,
    RAID_CHECK_USER_QUERY_FIELDS,
    ROSTER_KEY_SEP,
    raidCheckRefreshLimiter,
    raidCheckSyncLimiter,
    discordUserLimiter,
    // raid-schedule bridge for all-mode's "📋 Đội đã xếp" dropdown.
    RaidEvent,
    buildScheduleEmbed,
    buildTurnPlanEmbed,
  } = deps;

  // Snapshot helpers extracted to ./raid-check/snapshot.js. Wired here so
  // the inner handlers below can call them directly without threading deps.
  const {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
  } = createSnapshotHelpers({
    User,
    buildRaidCheckUserQuery,
    RAID_CHECK_USER_QUERY_FIELDS,
    UI,
    ROSTER_KEY_SEP,
    toModeLabel,
    normalizeName,
    getRaidScanRange,
    ensureFreshWeek,
    ensureAssignedRaids,
    getCharacterName,
    getGateKeys,
    getGatesForRaid,
    raidCheckRefreshLimiter,
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
  });

  // Pure edit-flow helpers extracted to ./raid-check/edit-helpers.js.
  const {
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    formatGateStateLine,
    applyLocalRaidEditToChar,
    formatCharEditLabel,
    formatUserEditLabel,
  } = createEditHelpers({
    UI,
    normalizeName,
    toModeLabel,
    truncateText,
    getGatesForRaid,
    getGateKeys,
    getRaidScanRange,
    RAID_REQUIREMENT_MAP,
  });

  // /raid-check handler extracted to ./raid-check/all-mode.js.
  // Bound here so the existing inline call (`await handleRaidCheckAllCommand(...)`)
  // resolves through the local destructure.
  const { handleRaidCheckAllCommand } = createAllModeHandler({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    ensureFreshWeek,
    truncateText,
    buildAccountPageEmbed,
    buildStatusFooterText,
    summarizeRaidProgress,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    isRaidLeader,
    isManagerId,
    discordUserLimiter,
    raidCheckRefreshLimiter,
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
    RAID_CHECK_USER_QUERY_FIELDS,
    RAID_CHECK_PAGINATION_SESSION_MS,
    RaidEvent,
    buildScheduleEmbed,
    buildTurnPlanEmbed,
  });

  // Sync flow + shared display-name resolver extracted to
  // ./raid-check/sync-ui.js. Wired BEFORE createEditUi because edit-ui
  // consumes resolveCachedDisplayName as a dep (Edit cascade resolves
  // display names per editable user). The same resolver is also called
  // from the main /raid-check render path below, so the destructure has
  // to land before any handler body that references it gets invoked.
  const {
    resolveCachedDisplayName,
    handleRaidCheckSyncClick,
  } = createSyncUi({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    ensureFreshWeek,
    normalizeName,
    saveWithRetry,
    weekResetStartMs,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    syncRaidProfileFromBibleCollected,
    stampAutoManageAttempt,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    raidCheckSyncLimiter,
    discordUserLimiter,
    resolveDiscordDisplay,
    computeRaidCheckSnapshot,
  });

  const {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  } = createRaidCheckAutoManageUi({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    User,
    buildNoticeEmbed,
  });

  const { handleRaidCheckViewTasksClick } = createTaskViewUi({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    truncateText,
    buildPaginationRow,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

  async function handleRaidCheckCommand(interaction) {
    if (!isRaidLeader(interaction)) {
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await replyNotice(interaction, EmbedBuilder, {
        type: "lock",
        title: t("raid-check.auth.managerOnlyTitle", lang),
        description: t("raid-check.auth.managerOnlyDescription", lang),
      });
      return;
    }

    // Round-32: /raid-check is now a single entry point that always lands
    // in the cross-raid overview (all-mode). The previous per-raid render
    // path + open-time piggyback have been removed because the inline
    // raid-filter dropdown inside all-mode covers the same use case
    // without doubling command-line surface. Edit + Sync button flows
    // (which still need per-raid context) keep their dependencies via
    // computeRaidCheckSnapshot - that helper survived the cull because
    // it's reused by edit-ui.js and sync-ui.js for button-driven flows.
    await handleRaidCheckAllCommand(interaction);
  }

  async function handleRaidCheckButton(interaction) {
    const route = getRaidCheckButtonRoute(interaction.customId);

    const selfButtonHandlers = {
      [RAID_CHECK_BUTTON_HANDLER.disableAutoSelf]: () =>
        handleRaidCheckDisableAutoSelfClick(interaction, route.targetDiscordId),
      [RAID_CHECK_BUTTON_HANDLER.enableAutoSelf]: () =>
        handleRaidCheckEnableAutoSelfClick(interaction, route.targetDiscordId),
    };
    const managerButtonHandlers = {
      [RAID_CHECK_BUTTON_HANDLER.editAll]: () =>
        handleRaidCheckEditClick(interaction, null, null, route.preSelectedUserId),
      [RAID_CHECK_BUTTON_HANDLER.enableAutoOne]: () =>
        handleRaidCheckEnableAutoOneClick(interaction, route.targetDiscordId),
      [RAID_CHECK_BUTTON_HANDLER.disableAutoOne]: () =>
        handleRaidCheckDisableAutoOneClick(interaction, route.targetDiscordId),
      [RAID_CHECK_BUTTON_HANDLER.viewTasks]: () =>
        handleRaidCheckViewTasksClick(interaction, route.targetDiscordId),
    };
    const raidButtonHandlers = {
      [RAID_CHECK_BUTTON_HANDLER.sync]: (raidMeta) =>
        handleRaidCheckSyncClick(interaction, raidMeta),
      [RAID_CHECK_BUTTON_HANDLER.edit]: (raidMeta) =>
        handleRaidCheckEditClick(interaction, raidMeta, route.raidKey),
    };

    if (route.scope === RAID_CHECK_BUTTON_SCOPE.self) {
      await selfButtonHandlers[route.handler]();
      return;
    }

    // Everything below requires Raid Manager.
    if (!isRaidLeader(interaction)) {
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await replyNotice(interaction, EmbedBuilder, {
        type: "lock",
        title: t("raid-check.auth.buttonManagerOnlyTitle", clickerLang),
        description: t("raid-check.auth.buttonManagerOnlyDescription", clickerLang),
      });
      return;
    }

    if (route.scope === RAID_CHECK_BUTTON_SCOPE.manager) {
      const handler = managerButtonHandlers[route.handler];
      if (handler) await handler();
      return;
    }

    const raidMeta = RAID_REQUIREMENT_MAP[route.raidKey];
    if (!raidMeta) {
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await replyNotice(interaction, EmbedBuilder, {
        type: "warn",
        title: t("raid-check.staleButton.title", clickerLang),
        description: t("raid-check.staleButton.raidInvalidDescription", clickerLang),
      });
      return;
    }

    const raidHandler = raidButtonHandlers[route.handler];
    if (raidHandler) {
      await raidHandler(raidMeta);
      return;
    }

    const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await replyNotice(interaction, EmbedBuilder, {
      type: "warn",
      title: t("raid-check.staleButton.unsupportedActionTitle", clickerLang),
      description: t("raid-check.staleButton.unsupportedActionDescription", clickerLang, {
        action: route.action,
      }),
    });
  }

  const RAID_CHECK_EDIT_SESSION_MS = 3 * 60 * 1000;

  // Edit cascading-select flow extracted to ./raid-check/edit-ui.js.
  // Consumes resolveCachedDisplayName from the sync-ui factory above, so
  // sync-ui has to be wired first. RAID_CHECK_EDIT_SESSION_MS is the local
  // const right above. The 6 returned functions cross-call each other
  // through their shared closure, so we destructure and bind locally so
  // the call sites below stay unchanged.
  const {
    handleRaidCheckEditClick,
    buildRaidCheckEditDMEmbed,
  } = createEditUi({
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    normalizeName,
    truncateText,
    RAID_REQUIREMENT_MAP,
    resolveDiscordDisplay,
    resolveCachedDisplayName,
    discordUserLimiter,
    applyRaidSetForDiscordId,
    computeRaidCheckSnapshot,
    buildEditableCharsByUser,
    getCharRaidGateStatus,
    formatGateStateLine,
    formatCharEditLabel,
    formatUserEditLabel,
    applyLocalRaidEditToChar,
    RAID_CHECK_EDIT_SESSION_MS,
  });

  return {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    applyLocalRaidEditToChar,
    buildRaidCheckEditDMEmbed,
    handleRaidCheckCommand,
    handleRaidCheckButton,
  };
}

module.exports = {
  createRaidCheckCommand,
  RAID_CHECK_PAGINATION_SESSION_MS,
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
};
