"use strict";

const { getClassEmoji } = require("../../../models/Class");

/**
 * The closing card of a roster picker: "expired" (the session timed out) or
 * "cancelled" (the caller pressed Cancel). Its copy lives under
 * `<keyPrefix>.<state>.{title,description,footerText}`.
 * @param {object} args
 * @param {Function} args.EmbedBuilder
 * @param {object} args.UI - shared color and icon palette
 * @param {Function} args.t - translator
 * @param {string} args.keyPrefix - e.g. "raid-add-roster"
 * @param {"expired"|"cancelled"} args.state
 * @param {string} args.lang
 * @param {object} [args.vars] - description variables
 * @param {boolean} [args.withFooter=false] - add the footerText line
 * @returns {object} the embed
 */
function buildPickerClosedEmbed({
  EmbedBuilder,
  UI,
  t,
  keyPrefix,
  state,
  lang,
  vars = {},
  withFooter = false,
}) {
  const titleVars = state === "expired"
    ? { iconWarn: UI.icons.warn }
    : { iconInfo: UI.icons.info };
  const embed = new EmbedBuilder()
    .setTitle(t(`${keyPrefix}.${state}.title`, lang, titleVars))
    .setDescription(t(`${keyPrefix}.${state}.description`, lang, vars))
    .setColor(UI.colors.muted);
  if (withFooter) embed.setFooter({ text: t(`${keyPrefix}.${state}.footerText`, lang) });
  return embed;
}

/**
 * A class's icon, or its name while the icon is not known.
 * @param {string} className
 * @returns {string}
 */
function formatClassIcon(className) {
  return getClassEmoji(className) || className;
}

/**
 * One saved-roster line: "<class icon> **Name** · `iLvl` · CP `combat score`".
 * @param {{name: string, class: string, itemLevel: number, combatScore: string}} character
 * @param {string} [mark=""] - text after the name, such as " 🆕"
 * @returns {string}
 */
function formatSavedCharacterLine(character, mark = "") {
  return `${formatClassIcon(character.class)} **${character.name}**${mark} · \`${character.itemLevel}\` · CP \`${character.combatScore || "?"}\``;
}

module.exports = {
  buildPickerClosedEmbed,
  formatClassIcon,
  formatSavedCharacterLine,
};
