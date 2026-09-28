"use strict";

// tPick, not t: some titles here are variant pools; non-pool keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const { deleteBoardMessage } = require("../../../../services/raid/schedule/board-io");
const { pingCancelledSignups, signupDiscordIds } = require("./cancel-ping");

function createScheduleDeleteActions({
  boardLang,
  rejectUnlessLead,
  editNotice,
  deleteConfirmPayload,
  noticeEmbed,
}) {
  async function handleDeletePrompt(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang)) return;
    await interaction.reply(deleteConfirmPayload(event, lang));
  }

  async function handleDeleteConfirm(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang, editNotice)) return;
    await interaction.deferUpdate();

    const wasActive = event.status === "open" || event.status === "locked";
    const ids = signupDiscordIds(event);
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

    const boardDeleted = await deleteBoardMessage(interaction.client, event);
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

    if (wasActive) {
      await pingCancelledSignups(interaction.client, event, langForBoard, ids, "delete ping failed");
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
