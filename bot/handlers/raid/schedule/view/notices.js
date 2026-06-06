"use strict";

const { t } = require("../../../../services/i18n");

const EPHEMERAL_FLAG = 1 << 6;
const NOTICE_KICKER = Object.freeze({
  danger: "// ERROR",
  success: "// OK",
  warn: "// HEADS UP",
  info: "// INFO",
});
const NOTICE_COLOR_KEY = Object.freeze({
  danger: "danger",
  success: "success",
  warn: "progress",
  info: "neutral",
});

function createScheduleNoticeHelpers({
  EmbedBuilder,
  UI,
  ephemeralFlag = EPHEMERAL_FLAG,
}) {
  function noticeEmbed(type, title, description) {
    const colorKey = NOTICE_COLOR_KEY[type] || NOTICE_COLOR_KEY.info;
    const embed = new EmbedBuilder()
      .setColor(UI.colors[colorKey] ?? UI.colors.neutral)
      .setAuthor({ name: NOTICE_KICKER[type] || NOTICE_KICKER.info })
      .setTitle(title);
    if (description) embed.setDescription(description);
    return embed;
  }

  function noticePayload(lang, type, titleKey, descriptionKey, vars = {}) {
    return {
      embeds: [
        noticeEmbed(
          type,
          t(`raid-schedule.notice.${titleKey}`, lang, vars),
          descriptionKey ? t(`raid-schedule.notice.${descriptionKey}`, lang, vars) : "",
        ),
      ],
      flags: ephemeralFlag,
    };
  }

  async function replyNotice(interaction, lang, type, titleKey, descriptionKey, vars = {}) {
    const payload = noticePayload(lang, type, titleKey, descriptionKey, vars);
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
  }

  async function editNotice(interaction, lang, type, titleKey, descriptionKey, vars = {}) {
    return interaction.editReply({
      embeds: noticePayload(lang, type, titleKey, descriptionKey, vars).embeds,
      components: [],
    });
  }

  return {
    noticeEmbed,
    noticePayload,
    replyNotice,
    editNotice,
  };
}

module.exports = {
  createScheduleNoticeHelpers,
};
