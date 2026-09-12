"use strict";

const { t } = require("../../../../services/i18n");

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

function buildAutoManageCancelEmbed({ EmbedBuilder, UI, lang, decision, action }) {
  const prefix = `raid-auto-manage.${action}`;
  const titleKey = decision === "timeout" ? "cancelTimeoutTitle" : "cancelTitle";
  return new EmbedBuilder()
    .setColor(UI.colors.muted)
    .setTitle(`${UI.icons.reset} ${t(`${prefix}.${titleKey}`, lang)}`)
    .setDescription(t(`${prefix}.cancelDescription`, lang))
    .setTimestamp();
}

module.exports = { awaitAutoManageDecision, buildAutoManageCancelEmbed };
