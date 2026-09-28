"use strict";

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

/** One saved-roster line: "1. Name · Class · `iLvl` · `combat score`". */
function formatSavedCharacterLine(character, index) {
  return `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``;
}

module.exports = {
  buildPickerClosedEmbed,
  formatSavedCharacterLine,
};
