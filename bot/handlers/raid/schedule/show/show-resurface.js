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
  async function fetchBoardChannel(interaction, event) {
    if (!event.channelId || !interaction.client?.channels) return null;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      return channel?.send ? channel : null;
    } catch (error) {
      console.warn("[raid-schedule] resurface channel fetch failed:", error?.message || error);
      return null;
    }
  }

  async function postBoardMessage(channel, event, lang) {
    try {
      return await channel.send(await boardPayload(event, lang));
    } catch (error) {
      console.warn("[raid-schedule] resurface post failed:", error?.message || error);
      return null;
    }
  }

  async function deleteBoardMessage(channel, messageOrId, logLabel) {
    try {
      if (typeof messageOrId?.delete === "function") {
        await messageOrId.delete();
        return;
      }
      const messageId = messageOrId?.id || messageOrId;
      if (!messageId || !channel.messages?.fetch) return;
      const message = await channel.messages.fetch(messageId);
      if (message?.delete) await message.delete();
    } catch (error) {
      console.warn(`[raid-schedule] ${logLabel}:`, error?.message || error);
    }
  }

  async function persistResurfacedMessage(event, message, channel) {
    const oldMessageId = event.messageId;
    event.messageId = message.id;
    try {
      await event.save();
      return { ok: true, oldMessageId };
    } catch (error) {
      console.warn("[raid-schedule] resurface save failed:", error?.message || error);
      event.messageId = oldMessageId;
      await deleteBoardMessage(channel, message, "resurface new-delete failed");
      return { ok: false, oldMessageId };
    }
  }

  async function republishBoard(interaction, event, lang) {
    const channel = await fetchBoardChannel(interaction, event);
    if (!channel) return { ok: false };
    const message = await postBoardMessage(channel, event, lang);
    if (!message) return { ok: false };

    const persisted = await persistResurfacedMessage(event, message, channel);
    if (!persisted.ok) return { ok: false };
    if (persisted.oldMessageId && persisted.oldMessageId !== message.id) {
      await deleteBoardMessage(channel, persisted.oldMessageId, "resurface old-delete failed");
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
