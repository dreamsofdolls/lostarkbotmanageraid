"use strict";

const { t } = require("../../../../services/i18n");
const { NoticeKind, buildNoticeEmbed } = require("../../../../utils/raid/common/shared");

// Only a cancelled enable has a next step worth a tip.
const CANCEL_TIP_KEYS = Object.freeze({
  enable: "raid-auto-manage.enable.cancelTip",
});

async function awaitAutoManageDecision({
  interaction, discordId, ComponentType, customIdPrefix, confirmId,
}) {
  const replyMsg = await interaction.fetchReply();
  try {
    const button = await replyMsg.awaitMessageComponent({
      filter: candidate => candidate.user.id === discordId && candidate.customId.startsWith(customIdPrefix),
      componentType: ComponentType.Button,
      time: 60_000,
    });
    await button.deferUpdate().catch(() => {});
    return button.customId === confirmId ? "confirm" : "cancel";
  } catch {
    return "timeout";
  }
}

/**
 * The card after an enable or reset prompt is declined: a pressed Cancel is
 * done, an unanswered prompt is expired.
 * @param {object} args
 * @param {Function} args.EmbedBuilder
 * @param {string} args.lang
 * @param {"cancel"|"timeout"} args.decision
 * @param {"enable"|"reset"} args.action
 * @returns {object} discord.js EmbedBuilder
 */
function buildAutoManageCancelEmbed({ EmbedBuilder, lang, decision, action }) {
  const prefix = `raid-auto-manage.${action}`;
  const timedOut = decision === "timeout";
  const tipKey = CANCEL_TIP_KEYS[action];
  return buildNoticeEmbed(EmbedBuilder, {
    kind: timedOut ? NoticeKind.EXPIRED : NoticeKind.DONE,
    title: t(`${prefix}.${timedOut ? "cancelTimeoutTitle" : "cancelTitle"}`, lang),
    description: t(`${prefix}.cancelDescription`, lang),
    tip: tipKey ? t(tipKey, lang) : undefined,
  });
}

module.exports = { awaitAutoManageDecision, buildAutoManageCancelEmbed };
