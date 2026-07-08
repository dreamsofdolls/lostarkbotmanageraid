/**
 * handlers/raid/auto-manage.js
 * /raid-auto-manage: user-facing entry to the bible-log clear-sync
 * service. Subactions: on / off / sync / status / local-on /
 * local-off / reset. Wires the slash UI to the underlying core
 * service in services/auto-manage/runtime/core.js and the encounters.db
 * web-companion path in services/local-sync.
 */

"use strict";

const {
  editEmbed,
  editNotice,
  replyEmbed,
  replyNotice,
} = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  buildAutoManageAutocompleteChoices,
  getAutoManageStateGate,
  isValidAutoManageAction,
  shouldReadAutoManageState,
} = require("./auto-manage/action-policy");
const {
  createAutoManageBasicActionHandlers,
} = require("./auto-manage/basic-actions");
const {
  createAutoManageCoreActionHandlers,
} = require("./auto-manage/core-actions");

/**
 * Build the /raid-auto-manage command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders,
 *   Mongoose User model, the core auto-manage service handles, local-
 *   sync helpers, cooldown resolvers Â· see destructure block).
 * @returns {{
 *   handleRaidAutoManageCommand: Function,
 *   handleRaidAutoManageAutocomplete: Function,
 * }} handlers wired into commands.js dispatch + autocomplete maps
 */
function createRaidAutoManageCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    getAutoManageCooldownMs,
    weekResetStartMs,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageSyncReportEmbed,
    buildAutoManageHiddenCharsWarningEmbed,
    stampAutoManageAttempt,
  } = deps;
  const basicActionHandlers = createAutoManageBasicActionHandlers({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    User,
  });
  const coreActionHandlers = createAutoManageCoreActionHandlers({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    getAutoManageCooldownMs,
    weekResetStartMs,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageSyncReportEmbed,
    buildAutoManageHiddenCharsWarningEmbed,
    stampAutoManageAttempt,
  });
  const actionHandlers = {
    ...basicActionHandlers,
    ...coreActionHandlers,
  };

  async function handleRaidAutoManageCommand(interaction) {
    const discordId = interaction.user.id;
    // Slash invoker is the only viewer of every ephemeral reply on this
    // command, so resolve once and thread through every notice + success
    // embed. DM emitters resolve their own (recipient's) lang separately
    // via commitAutoManageOn / buildAutoManage* helpers further down.
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const replyAutoNotice = (options, extras) => replyNotice(interaction, EmbedBuilder, options, extras);
    const replyAutoEmbed = (embed, extras) => replyEmbed(interaction, embed, extras);
    const editAutoNotice = (options, extras) => editNotice(interaction, EmbedBuilder, options, extras);
    const editAutoEmbed = (embed, extras) => editEmbed(interaction, embed, extras);
    const action = interaction.options.getString("action", true);
    if (!isValidAutoManageAction(action)) {
      await replyAutoNotice({
        type: "warn",
        title: t("raid-auto-manage.invalid.actionTitle", lang),
        description: t("raid-auto-manage.invalid.actionDescription", lang, { action }),
      });
      return;
    }
    if (shouldReadAutoManageState(action)) {
      const stateUser = await User.findOne(
        { discordId },
        { autoManageEnabled: 1, localSyncEnabled: 1 }
      ).lean();
      const bibleOn = !!stateUser?.autoManageEnabled;
      const localOn = !!stateUser?.localSyncEnabled;
      const gate = getAutoManageStateGate(action, { bibleOn, localOn });
      if (gate) {
        await replyAutoNotice({
          type: gate.type,
          title: t(gate.titleKey, lang),
          description: t(gate.descriptionKey, lang),
        });
        return;
      }
    }
    const actionHandler = actionHandlers[action];
    if (actionHandler) {
      await actionHandler({
        interaction,
        discordId,
        lang,
        replyAutoNotice,
        replyAutoEmbed,
        editAutoNotice,
        editAutoEmbed,
      });
      return;
    }
    console.warn(`[raid-auto-manage] no handler registered for action=${action}`);
    await replyAutoNotice({
      type: "warn",
      title: t("raid-auto-manage.invalid.actionTitle", lang),
      description: t("raid-auto-manage.invalid.actionDescription", lang, { action }),
    });
  }

  async function handleRaidAutoManageAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      let bibleOn = false;
      let localOn = false;
      try {
        const user = await User.findOne(
          { discordId: interaction.user.id },
          { autoManageEnabled: 1, localSyncEnabled: 1 }
        ).lean();
        bibleOn = !!user?.autoManageEnabled;
        localOn = !!user?.localSyncEnabled;
      } catch (err) {
        console.warn("[autocomplete] auto-manage state load failed:", err?.message || err);
      }
      const choices = buildAutoManageAutocompleteChoices({
        bibleOn,
        localOn,
        needle: focused.value,
        lang,
        t,
        normalizeName,
      });
      await interaction.respond(choices).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-auto-manage error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }

  return {
    handleRaidAutoManageCommand,
    handleRaidAutoManageAutocomplete,
  };
}

module.exports = {
  createRaidAutoManageCommand,
};
