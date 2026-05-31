"use strict";

const crypto = require("crypto");

function newPickerSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

function truncateButtonLabel(value) {
  const text = String(value || "");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function buildToggleButtonRows({
  session,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  customIdPrefix,
  buttonsPerRow,
  describeButton,
}) {
  const rows = [];
  for (let rowStart = 0; rowStart < session.chars.length; rowStart += buttonsPerRow) {
    const row = new ActionRowBuilder();
    const rowEnd = Math.min(rowStart + buttonsPerRow, session.chars.length);
    for (let index = rowStart; index < rowEnd; index += 1) {
      const description = describeButton(session.chars[index], index, session);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${customIdPrefix}:toggle:${session.sessionId}:${index}`)
          .setLabel(truncateButtonLabel(description.label))
          .setStyle(description.selected ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildConfirmCancelRow({
  session,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  customIdPrefix,
  confirmLabel,
  cancelLabel,
  confirmDisabled = false,
}) {
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`${customIdPrefix}:confirm:${session.sessionId}`)
    .setLabel(confirmLabel)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(confirmDisabled);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`${customIdPrefix}:cancel:${session.sessionId}`)
    .setLabel(cancelLabel)
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
}

function buildTogglePickerComponents(options) {
  return [
    ...buildToggleButtonRows(options),
    buildConfirmCancelRow(options),
  ];
}

module.exports = {
  newPickerSessionId,
  truncateButtonLabel,
  buildToggleButtonRows,
  buildConfirmCancelRow,
  buildTogglePickerComponents,
};
