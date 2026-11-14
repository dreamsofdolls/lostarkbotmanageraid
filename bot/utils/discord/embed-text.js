"use strict";

/**
 * bot/utils/discord/embed-text.js
 * Text that another user chose (a server name, a nickname, a task name) is
 * shown in embeds as plain text: markdown marks are escaped, and so are the
 * brackets of a masked link, which escapeMarkdown leaves alone.
 */

const { escapeMarkdown } = require("discord.js");

/**
 * Escape text for an embed description or field value.
 * @param {unknown} value - the text; null and undefined become ""
 * @returns {string} the text with markdown and masked-link brackets escaped
 */
function escapeEmbedText(value) {
  return escapeMarkdown(String(value ?? "")).replace(/[[\]]/g, "\\$&");
}

module.exports = { escapeEmbedText };
