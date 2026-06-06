"use strict";

const { t } = require("../../../../services/i18n");

function createScheduleDeleteActions({
  boardLang,
  rejectUnlessLead,
  editNotice,
  deleteConfirmPayload,
  noticeEmbed,
}) {
  async function deleteBoardMessage(interaction, event) {
    if (!event.messageId || !event.channelId || !interaction.client?.channels) return false;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      const message = await channel?.messages?.fetch(event.messageId);
      if (message) {
        await message.delete();
        return true;
      }
    } catch (error) {
      console.warn("[raid-schedule] board delete failed:", error?.message || error);
    }
    return false;
  }

  async function handleDeletePrompt(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang)) return;
    await interaction.reply(deleteConfirmPayload(event, lang));
  }

  async function handleDeleteConfirm(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang, editNotice)) return;
    await interaction.deferUpdate();

    const wasActive = event.status === "open" || event.status === "locked";
    const ids = [...new Set((event.signups || []).map((s) => s.discordId))];
    const langForBoard = await boardLang(event.guildId);

    try {
      await event.deleteOne();
    } catch (error) {
      console.warn("[raid-schedule] event delete failed:", error?.message || error);
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            "danger",
            t("raid-schedule.notice.deleteFailedTitle", lang),
            t("raid-schedule.notice.deleteFailedDescription", lang),
          ),
        ],
        components: [],
      }).catch(() => {});
      return;
    }

    const boardDeleted = await deleteBoardMessage(interaction, event);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.notice.deletedTitle", lang),
          t(
            boardDeleted
              ? "raid-schedule.notice.deletedDescription"
              : "raid-schedule.notice.deletedBoardMissingDescription",
            lang,
          ),
        ),
      ],
      components: [],
    }).catch(() => {});

    if (wasActive && ids.length > 0 && !event.skipNotify) {
      try {
        const channel = await interaction.client.channels.fetch(event.channelId);
        await channel?.send?.({
          content: t("raid-schedule.notice.cancelPingContent", langForBoard, {
            users: ids.map((uid) => `<@${uid}>`).join(" "),
            title: event.title || "",
          }),
        });
      } catch (error) {
        console.warn("[raid-schedule] delete ping failed:", error?.message || error);
      }
    }
  }

  async function handleDeleteAbort(interaction, event, lang) {
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.deleteAbortedTitle", lang),
          t("raid-schedule.notice.deleteAbortedDescription", lang),
        ),
      ],
      components: [],
    }).catch(() => {});
  }

  return {
    handleDeleteAbort,
    handleDeleteConfirm,
    handleDeletePrompt,
  };
}

module.exports = {
  createScheduleDeleteActions,
};
