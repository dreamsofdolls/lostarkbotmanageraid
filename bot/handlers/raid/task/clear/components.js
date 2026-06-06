"use strict";

const { t } = require("../../../../services/i18n");

function buildClearConfirmRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  resolvedRosterName,
  resolvedCharName,
  lang,
}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `raid-task:clear-confirm:${encodeURIComponent(resolvedRosterName)}:${encodeURIComponent(resolvedCharName)}`
      )
      .setLabel(t("raid-task.clear.confirmButtonLabel", lang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("raid-task:clear-cancel")
      .setLabel(t("raid-task.clear.cancelButtonLabel", lang))
      .setStyle(ButtonStyle.Secondary)
  );
}

module.exports = {
  buildClearConfirmRow,
};
