"use strict";

const { t } = require("../../../../services/i18n");
const { pingCancelledSignups, signupDiscordIds } = require("./cancel-ping");

function createScheduleCancelActions({
  boardLang,
  editBoardMessage,
  rejectUnlessLeadMutable,
  noticeEmbed,
  ephemeralFlag,
}) {
  async function handleCancel(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    await interaction.deferUpdate();
    event.status = "cancelled";
    event.cancelledAt = new Date();
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.notice.cancelledTitle", lang),
          t("raid-schedule.notice.cancelledDescription", lang)
        ),
      ],
      components: [],
      flags: ephemeralFlag,
    }).catch(() => {});

    await pingCancelledSignups(
      interaction.client, event, langForBoard, signupDiscordIds(event), "cancel ping failed"
    );
  }

  return {
    handleCancel,
  };
}

module.exports = {
  createScheduleCancelActions,
};
