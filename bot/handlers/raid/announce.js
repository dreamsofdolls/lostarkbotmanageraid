/**
 * handlers/raid/announce.js
 * /raid-announce: per-guild config for announcement types. Admin-only:
 * show / on / off / set-channel / clear-channel.
 */

"use strict";

const { replyEmbed, replyNotice } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  createRaidAnnounceAutocompleteHandler,
} = require("./announce/autocomplete");
const {
  getRaidAnnounceActionHandler,
  isValidRaidAnnounceAction,
} = require("./announce/actions");

function hasManageGuild(interaction, PermissionFlagsBits) {
  return !!(
    interaction.memberPermissions &&
    interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function buildCurrentEntry({ type, entry }) {
  return {
    entry,
    type,
    subdocKey: entry.subdocKey,
    typeLabel: entry.label,
    overridable: entry.channelOverridable,
  };
}

function createRaidAnnounceCommand(deps) {
  const {
    EmbedBuilder,
    PermissionFlagsBits,
    User,
    GuildConfig,
    announcementTypeEntry,
    getAnnouncementsConfig,
  } = deps;

  async function handleRaidAnnounceCommand(interaction) {
    const guildId = interaction.guildId;
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const replyAnnounceNotice = (options) =>
      replyNotice(interaction, EmbedBuilder, options);
    const replyAnnounceEmbed = (embed) => replyEmbed(interaction, embed);

    if (!guildId) {
      await replyAnnounceNotice({
        type: "warn",
        title: t("raid-announce.auth.serverOnlyTitle", lang),
        description: t("raid-announce.auth.serverOnlyDescription", lang),
      });
      return;
    }
    if (!hasManageGuild(interaction, PermissionFlagsBits)) {
      await replyAnnounceNotice({
        type: "lock",
        title: t("raid-announce.auth.manageGuildTitle", lang),
        description: t("raid-announce.auth.manageGuildDescription", lang),
      });
      return;
    }

    const type = interaction.options.getString("type", true);
    const action = interaction.options.getString("action", true);
    if (!isValidRaidAnnounceAction(action)) {
      await replyAnnounceNotice({
        type: "warn",
        title: t("raid-announce.invalid.actionTitle", lang),
        description: t("raid-announce.invalid.actionDescription", lang, { action }),
      });
      return;
    }

    const entry = announcementTypeEntry(type);
    if (!entry) {
      await replyAnnounceNotice({
        type: "warn",
        title: t("raid-announce.invalid.typeTitle", lang),
        description: t("raid-announce.invalid.typeDescription", lang, { type }),
      });
      return;
    }

    const existing = await GuildConfig.findOne({ guildId }).lean();
    const currentEntry = buildCurrentEntry({ type, entry });
    const current = getAnnouncementsConfig(existing)[entry.subdocKey];
    const actionHandler = getRaidAnnounceActionHandler(action);
    await actionHandler({
      ...deps,
      action,
      channel: interaction.options.getChannel("channel", false),
      current,
      currentEntry,
      existing,
      guildId,
      interaction,
      lang,
      replyAnnounceEmbed,
      replyAnnounceNotice,
      type,
    });
  }

  return {
    handleRaidAnnounceCommand,
    handleRaidAnnounceAutocomplete: createRaidAnnounceAutocompleteHandler(deps),
  };
}

module.exports = {
  createRaidAnnounceCommand,
  __test: {
    buildCurrentEntry,
    hasManageGuild,
  },
};
