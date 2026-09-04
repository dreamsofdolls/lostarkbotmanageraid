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
const { filterRaidCheckRequirementMap } = require("./visibility");
const {
  deferEphemeralReply,
  editNotice,
} = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  RAID_CHECK_BUTTON_HANDLER,
  RAID_CHECK_BUTTON_SCOPE,
  getRaidCheckButtonRoute,
} = require("./button-routes");

const RAID_CHECK_PAGINATION_SESSION_MS = 5 * 60 * 1000;

/**
 * Compose the manager overview and its edit/sync flows. Child factories declare
 * their own dependencies; locally derived helpers and visibility rules override
 * the shared dependencies when needed.
 * @param {object} deps - Discord builders, User model, raid helpers and sync services.
 * @returns {object} Command/button handlers and shared snapshot/edit helpers.
 */
function createRaidCheckCommand(deps) {
  const {
    EmbedBuilder,
    User,
    isRaidLeader,
    RAID_REQUIREMENT_MAP: FULL_RAID_REQUIREMENT_MAP,
  } = deps;

  const RAID_REQUIREMENT_MAP = filterRaidCheckRequirementMap(
    FULL_RAID_REQUIREMENT_MAP
  );

  const {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
  } = createSnapshotHelpers(deps);

  const {
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    formatGateStateLine,
    applyLocalRaidEditToChar,
    formatCharEditLabel,
    formatUserEditLabel,
  } = createEditHelpers({ ...deps, RAID_REQUIREMENT_MAP });

  const { handleRaidCheckAllCommand } = createAllModeHandler({
    ...deps,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

  // Build Sync before Edit so both use the same cached display-name resolver.
  const {
    resolveCachedDisplayName,
    handleRaidCheckSyncClick,
  } = createSyncUi({ ...deps, computeRaidCheckSnapshot });

  const {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  } = createRaidCheckAutoManageUi(deps);

  const { handleRaidCheckViewTasksClick } = createTaskViewUi({
    ...deps,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

  async function handleRaidCheckCommand(interaction) {
    // /raid-check always lands in the cross-raid overview. Its inline
    // raid filter owns per-raid focus, while Edit and Sync reuse
    // computeRaidCheckSnapshot for their button-driven context.
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
      await deferEphemeralReply(interaction);
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNotice(interaction, EmbedBuilder, {
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
      await deferEphemeralReply(interaction);
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNotice(interaction, EmbedBuilder, {
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

    await deferEphemeralReply(interaction);
    const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await editNotice(interaction, EmbedBuilder, {
      type: "warn",
      title: t("raid-check.staleButton.unsupportedActionTitle", clickerLang),
      description: t("raid-check.staleButton.unsupportedActionDescription", clickerLang, {
        action: route.action,
      }),
    });
  }

  const RAID_CHECK_EDIT_SESSION_MS = 3 * 60 * 1000;

  const {
    handleRaidCheckEditClick,
    buildRaidCheckEditDMEmbed,
  } = createEditUi({
    ...deps,
    RAID_REQUIREMENT_MAP,
    resolveCachedDisplayName,
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
