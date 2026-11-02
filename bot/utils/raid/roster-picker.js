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
      const button = new ButtonBuilder()
        .setCustomId(`${customIdPrefix}:toggle:${session.sessionId}:${index}`)
        .setLabel(truncateButtonLabel(description.label))
        .setStyle(description.selected ? ButtonStyle.Success : ButtonStyle.Secondary);
      if (description.emoji) button.setEmoji(description.emoji);
      row.addComponents(button);
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

const SELECT_OPTION_TEXT_MAX = 100;

function clipOptionText(value) {
  const text = String(value || "");
  return text.length > SELECT_OPTION_TEXT_MAX ? `${text.slice(0, SELECT_OPTION_TEXT_MAX - 3)}...` : text;
}

/**
 * A roster picker driven by one multi-select: no option is pre-selected, so
 * the closed menu always shows the placeholder, and every option picked on
 * submit flips that character. Confirm/Cancel keep their own row.
 * @param {object} options
 * @param {object} options.session - picker session with `sessionId` and `chars`
 * @param {Function} options.StringSelectMenuBuilder
 * @param {string} options.customIdPrefix - e.g. "add-roster"
 * @param {string} options.placeholder
 * @param {(character: object, index: number) => {label: string, description: string, emoji?: object}} options.describeOption
 * @returns {object[]} two action rows: the select, then Confirm/Cancel
 */
function buildFlipPickerComponents(options) {
  const { session, ActionRowBuilder, StringSelectMenuBuilder, customIdPrefix, placeholder, describeOption } = options;
  const selectOptions = session.chars.map((character, index) => {
    const { label, description, emoji } = describeOption(character, index);
    return {
      label: clipOptionText(label),
      description: clipOptionText(description),
      value: String(index),
      ...(emoji ? { emoji } : {}),
    };
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${customIdPrefix}:pick:${session.sessionId}`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(selectOptions.length)
    .addOptions(selectOptions);
  return [
    new ActionRowBuilder().addComponents(select),
    buildConfirmCancelRow(options),
  ];
}

function resolveAdminMention(getPrimaryManagerId) {
  const id = typeof getPrimaryManagerId === "function" ? getPrimaryManagerId() : null;
  return id ? `<@${id}>` : "admin";
}

function clearPickerSession(sessions, sessionId, { timerField = "expireTimer" } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session[timerField]) {
    clearTimeout(session[timerField]);
    session[timerField] = null;
  }
  sessions.delete(sessionId);
  return session;
}

async function handlePickerSessionTimeout({
  sessions,
  sessionId,
  interaction,
  buildExpiredEmbed,
  logTag,
  timerField = "expireTimer",
}) {
  const session = clearPickerSession(sessions, sessionId, { timerField });
  if (!session) return;
  try {
    await interaction.editReply({
      embeds: [buildExpiredEmbed(session)],
      components: [],
    });
  } catch (err) {
    console.warn(
      `[${logTag}] timeout edit failed for session ${sessionId}: ${err?.message || err}`
    );
  }
}

async function authorizePickerSession({
  interaction,
  session,
  User,
  getUserLanguage,
  buildNoticeEmbed,
  EmbedBuilder,
  MessageFlags,
  t,
  titleKey,
  descriptionKey,
}) {
  if (interaction.user.id === session.callerId) return null;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
  await interaction.editReply({
    embeds: [
      buildNoticeEmbed(EmbedBuilder, {
        type: "lock",
        title: t(titleKey, clickerLang),
        description: t(descriptionKey, clickerLang),
      }),
    ],
  });
  return true;
}

module.exports = {
  newPickerSessionId,
  buildFlipPickerComponents,
  buildTogglePickerComponents,
  resolveAdminMention,
  clearPickerSession,
  handlePickerSessionTimeout,
  authorizePickerSession,
};
