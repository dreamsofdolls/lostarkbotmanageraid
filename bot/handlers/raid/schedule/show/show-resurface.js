"use strict";

const { t } = require("../../../../services/i18n");

function createScheduleShowResurfaceActions({
  RaidEvent,
  ephemeralFlag,
  userLang,
  boardLang,
  boardPayload,
  raidMetaFor,
  rejectUnlessLead,
  replyNotice,
  editNotice,
  noticeEmbed,
  turnPlanDashboardPayload,
}) {
  async function republishBoard(interaction, event, lang) {
    if (!event.channelId || !interaction.client?.channels) return { ok: false };
    let channel;
    try {
      channel = await interaction.client.channels.fetch(event.channelId);
    } catch (error) {
      console.warn("[raid-schedule] resurface channel fetch failed:", error?.message || error);
      return { ok: false };
    }
    if (!channel?.send) return { ok: false };

    let message;
    try {
      message = await channel.send(await boardPayload(event, lang));
    } catch (error) {
      console.warn("[raid-schedule] resurface post failed:", error?.message || error);
      return { ok: false };
    }

    const oldMessageId = event.messageId;
    event.messageId = message.id;
    try {
      await event.save();
    } catch (error) {
      console.warn("[raid-schedule] resurface save failed:", error?.message || error);
      event.messageId = oldMessageId;
      try {
        if (typeof message.delete === "function") {
          await message.delete();
        } else if (message.id && channel.messages?.fetch) {
          const fresh = await channel.messages.fetch(message.id);
          if (fresh?.delete) await fresh.delete();
        }
      } catch (cleanupError) {
        console.warn("[raid-schedule] resurface new-delete failed:", cleanupError?.message || cleanupError);
      }
      return { ok: false };
    }

    if (oldMessageId && oldMessageId !== message.id) {
      try {
        const old = await channel.messages.fetch(oldMessageId);
        if (old) await old.delete();
      } catch (error) {
        console.warn("[raid-schedule] resurface old-delete failed:", error?.message || error);
      }
    }
    return { ok: true, message };
  }

  function resurfacedNoticeEmbed(event, lang, message) {
    const raidLabel = raidMetaFor(event.raidKey, event.modeKey)?.label || `${event.raidKey} ${event.modeKey}`;
    return noticeEmbed(
      "success",
      t("raid-schedule.notice.resurfacedTitle", lang),
      t("raid-schedule.notice.resurfacedDescription", lang, {
        raid: raidLabel,
        channel: `<#${event.channelId}>`,
        link: message.url,
      }),
    );
  }

  async function findOwnedBoards(guildId, creatorId, sortSpec) {
    return RaidEvent.find({
      guildId,
      creatorId,
      status: { $in: ["open", "locked"] },
    }).sort(sortSpec);
  }

  function pickCurrentChannelBoard(boards, channelId) {
    return boards.find((e) => String(e.channelId) === String(channelId)) || boards[0];
  }

  async function handleShowResurface(interaction) {
    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) return;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId || interaction.channel?.id;
    if (!guildId || !channelId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }

    const mine = await findOwnedBoards(guildId, interaction.user.id, { createdAt: -1 });
    if (mine.length === 0) {
      await replyNotice(interaction, lang, "warn", "showNoBoardsTitle", "showNoBoardsDescription");
      return;
    }

    const target = pickCurrentChannelBoard(mine, channelId);
    await interaction.deferReply({ flags: ephemeralFlag });
    const langForBoard = await boardLang(target.guildId);
    const res = await republishBoard(interaction, target, langForBoard);
    if (!res.ok) {
      await editNotice(interaction, lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription");
      return;
    }
    await interaction.editReply({ embeds: [resurfacedNoticeEmbed(target, lang, res.message)], components: [] });
  }

  async function handleShowTurnPlan(interaction) {
    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) return;
    const guildId = interaction.guildId || interaction.guild?.id;
    if (!guildId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }

    const channelId = interaction.channelId || interaction.channel?.id;
    const mine = await findOwnedBoards(guildId, interaction.user.id, { startAt: 1 });
    if (mine.length === 0) {
      await replyNotice(interaction, lang, "warn", "showNoBoardsTitle", "showNoBoardsDescription");
      return;
    }

    const target = pickCurrentChannelBoard(mine, channelId);
    await interaction.reply(turnPlanDashboardPayload(target, mine, lang));
  }

  return {
    handleShowResurface,
    handleShowTurnPlan,
    republishBoard,
  };
}

module.exports = {
  createScheduleShowResurfaceActions,
};
