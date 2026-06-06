"use strict";

const { t } = require("../../../../services/i18n");

function createScheduleCancelActions({
  boardLang,
  editBoardMessage,
  rejectUnlessLeadMutable,
  noticeEmbed,
  ephemeralFlag,
}) {
  function signupDiscordIds(event) {
    return [...new Set((event.signups || []).map((signup) => signup.discordId))];
  }

  async function pingCancelledSignups(interaction, event, langForBoard, ids) {
    if (ids.length === 0 || event.skipNotify) return;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      await channel?.send?.({
        content: t("raid-schedule.notice.cancelPingContent", langForBoard, {
          users: ids.map((id) => `<@${id}>`).join(" "),
          title: event.title || "",
        }),
      });
    } catch (error) {
      console.warn("[raid-schedule] cancel ping failed:", error?.message || error);
    }
  }

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

    await pingCancelledSignups(interaction, event, langForBoard, signupDiscordIds(event));
  }

  return {
    handleCancel,
    pingCancelledSignups,
    signupDiscordIds,
  };
}

module.exports = {
  createScheduleCancelActions,
};
