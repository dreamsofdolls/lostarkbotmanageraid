/**
 * handlers/raid-check/index.js
 * Compose root for /raid-check (Manager-only cross-raid overview).
 * Wires the sync flow + all-mode + auto-manage UI into one handler bag
 * dispatched from commands.js. Owns the per-session pagination timer.
 */

const { createAllModeHandler } = require("./all-mode/all-mode");
const { createSyncUi } = require("./views/sync-ui");
const {
  createRaidCheckAutoManageUi,
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
} = require("./auto-manage/auto-manage");
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
 * Compose the manager overview and its sync flow. Child factories declare
 * their own dependencies.
 * @param {object} deps - Discord builders, User model, raid helpers and sync services.
 * @returns {object} Command and button handlers.
 */
function createRaidCheckCommand(deps) {
  const {
    EmbedBuilder,
    User,
    isRaidLeader,
  } = deps;

  const { handleRaidCheckAllCommand } = createAllModeHandler({
    ...deps,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

  const { handleRaidCheckSyncClick } = createSyncUi(deps);

  const {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  } = createRaidCheckAutoManageUi(deps);

  async function handleRaidCheckCommand(interaction) {
    // /raid-check always lands in the cross-raid overview; its inline raid
    // filter owns per-raid focus.
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
      [RAID_CHECK_BUTTON_HANDLER.syncAll]: () =>
        handleRaidCheckSyncClick(interaction),
      [RAID_CHECK_BUTTON_HANDLER.enableAutoOne]: () =>
        handleRaidCheckEnableAutoOneClick(interaction, route.targetDiscordId),
      [RAID_CHECK_BUTTON_HANDLER.disableAutoOne]: () =>
        handleRaidCheckDisableAutoOneClick(interaction, route.targetDiscordId),
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

    const handler = managerButtonHandlers[route.handler];
    if (handler) {
      await handler();
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

  return {
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
