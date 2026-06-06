"use strict";

const { t } = require("../../../../services/i18n");
const { getRaidPartySize } = require("../../../../domain/raid-catalog");
const { slotCountsForSize } = require("../../../../services/raid/schedule/slot-config");
const { parseStartTime } = require("../../../../services/raid/schedule/time-parse");
const { renderGauge } = require("../view/board");

function createScheduleCoreActions({
  RaidEvent,
  ephemeralFlag,
  userLang,
  boardLang,
  boardPayload,
  editBoardMessage,
  isCompMember,
  onBoardMessage,
  raidMetaFor,
  rejectUnlessLead,
  rejectUnlessLeadMutable,
  writeAutoClears,
  manageMenuPayload,
  noticeEmbed,
  replyNotice,
}) {
  async function handleCreateCommand(interaction) {
    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) {
      return;
    }

    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId || interaction.channel?.id;
    if (!guildId || !channelId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }

    const raidKey = interaction.options.getString("raid", true);
    const modeKey = interaction.options.getString("mode", true);
    const meta = raidMetaFor(raidKey, modeKey);
    if (!meta) {
      await replyNotice(interaction, lang, "danger", "invalidModeTitle", "invalidModeDescription");
      return;
    }

    const startAt = parseStartTime(interaction.options.getString("when", true), lang);
    if (!startAt) {
      await replyNotice(interaction, lang, "danger", "invalidTimeTitle", "invalidTimeDescription");
      return;
    }

    const partySize = getRaidPartySize(raidKey);
    const { supSlots, dpsSlots } = slotCountsForSize(partySize);
    const event = new RaidEvent({
      guildId,
      channelId,
      creatorId: interaction.user.id,
      raidKey,
      modeKey,
      minItemLevel: meta.minItemLevel,
      partySize,
      supSlots,
      dpsSlots,
      title: (interaction.options.getString("title") || `${meta.label}`).trim(),
      startAt,
      autoLockAtStart: interaction.options.getBoolean("auto_lock") ?? true,
      skipNotify: interaction.options.getBoolean("skip_notify") ?? false,
      status: "open",
      signups: [],
    });

    await interaction.deferReply();
    await event.save();

    const langForBoard = await boardLang(guildId);
    const message = await interaction.editReply(await boardPayload(event, langForBoard));
    const savedMessage = message?.id ? message : await interaction.fetchReply();
    event.messageId = savedMessage?.id || null;
    await event.save();
  }

  async function handleLockToggle(interaction, event, action, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    const onBoard = onBoardMessage(interaction, event);
    event.status = action === "unlock" ? "open" : "locked";
    await interaction.deferUpdate();
    await event.save();
    const langForBoard = await boardLang(event.guildId);
    if (onBoard) {
      await interaction.editReply(await boardPayload(event, langForBoard));
      return;
    }
    await editBoardMessage(interaction, event, langForBoard);
    const menu = manageMenuPayload(event, lang);
    await interaction.editReply({ embeds: menu.embeds, components: menu.components });
  }

  async function handleEnd(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;

    await interaction.deferUpdate();
    const summary = await writeAutoClears(interaction, event);
    event.status = "cleared";
    event.clearedAt = new Date();
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    const onBoard = onBoardMessage(interaction, event);
    const endGauge = renderGauge(summary.updated, summary.targets);
    const summaryEmbed = noticeEmbed(
      summary.failed > 0 ? "warn" : "success",
      t("raid-schedule.notice.endedTitle", lang, summary),
      `${endGauge ? `${endGauge}  ` : ""}${t("raid-schedule.notice.endedDescription", lang, summary)}`
    );
    if (onBoard) {
      await interaction.editReply(await boardPayload(event, langForBoard));
      await interaction.followUp({ embeds: [summaryEmbed], flags: ephemeralFlag }).catch(() => {});
      return;
    }
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({ embeds: [summaryEmbed], components: [] });
  }

  async function handleRoom(interaction, event, lang) {
    if (!isCompMember(event, interaction.user.id)) {
      await replyNotice(interaction, lang, "warn", "roomDeniedTitle", "roomDeniedDescription");
      return;
    }
    if (!event.roomName) {
      await replyNotice(interaction, lang, "info", "roomEmptyTitle", "roomEmptyDescription");
      return;
    }
    const passwordLine = event.roomPassword
      ? t("raid-schedule.notice.roomPasswordLine", lang, { password: event.roomPassword })
      : t("raid-schedule.notice.roomNoPasswordLine", lang);
    const roomRaidLabel = raidMetaFor(event.raidKey, event.modeKey)?.label || `${event.raidKey} ${event.modeKey}`;
    await interaction.reply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.roomTitle", lang),
          `\`${roomRaidLabel}\`\n${t("raid-schedule.notice.roomDescription", lang, {
            room: event.roomName,
            passwordLine,
          })}`
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleHelp(interaction, lang) {
    await interaction.reply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.helpTitle", lang),
          t("raid-schedule.notice.helpDescription", lang)
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleManage(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    await interaction.reply(manageMenuPayload(event, lang));
  }

  async function handleToggleNotify(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    event.skipNotify = !event.skipNotify;
    await interaction.deferUpdate();
    await event.save();
    const menu = manageMenuPayload(event, lang);
    await interaction.editReply({ embeds: menu.embeds, components: menu.components });
  }

  return {
    handleCreateCommand,
    handleEnd,
    handleHelp,
    handleLockToggle,
    handleManage,
    handleRoom,
    handleToggleNotify,
  };
}

module.exports = {
  createScheduleCoreActions,
};
