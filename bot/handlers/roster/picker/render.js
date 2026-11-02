"use strict";

const { getClassEmoji, isSupportClass } = require("../../../models/Class");
const { normalizeName, parseCombatScore } = require("../../../utils/raid/common/shared");

const ROSTER_ICON_UNKNOWN = "❓";
const FIELD_VALUE_LIMIT = 1024;
const CONTINUATION_FIELD_NAME = "​";

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

/**
 * The class icon that stands for a roster in card titles: the character
 * named like the roster first, then the rest by combat score, taking the
 * first class with a known emoji. A class whose emoji is not mapped yet
 * falls through to the next character instead of hiding the icon.
 * @param {string} rosterName
 * @param {Array<{name: string, className: string, combatScore?: string}>} characters
 * @returns {string} a class emoji, or ROSTER_ICON_UNKNOWN when none resolves
 */
function resolveRosterIcon(rosterName, characters) {
  const rosterKey = normalizeName(rosterName);
  const ordered = [...(characters || [])].sort((a, b) => {
    const aNamed = normalizeName(a.name) === rosterKey ? 1 : 0;
    const bNamed = normalizeName(b.name) === rosterKey ? 1 : 0;
    if (aNamed !== bNamed) return bNamed - aNamed;
    return parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore);
  });
  const icon = ordered.map((character) => getClassEmoji(character.className)).find(Boolean);
  return icon || ROSTER_ICON_UNKNOWN;
}

/**
 * Support and DPS counts for a set of classes, the 🛡️/⚔️ split the raid
 * dropdowns already use.
 * @param {string[]} classNames
 * @returns {{supports: number, dps: number}}
 */
function countRoles(classNames) {
  const supports = classNames.filter((className) => isSupportClass(className)).length;
  return { supports, dps: classNames.length - supports };
}

/**
 * Split list lines across embed fields so no value passes Discord's field
 * limit and no line is cut. The first field carries the name; the rest get
 * a blank name so they read as one list.
 * @param {string[]} lines
 * @param {string} name - the first field's name
 * @param {number} [limit=1024]
 * @returns {Array<{name: string, value: string, inline: false}>}
 */
function chunkLinesIntoFields(lines, name, limit = FIELD_VALUE_LIMIT) {
  const chunks = [];
  let current = "";
  for (const rawLine of lines) {
    const line = rawLine.slice(0, limit);
    const joined = current ? `${current}\n${line}` : line;
    if (current && joined.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((value, index) => ({
    name: index === 0 ? name : CONTINUATION_FIELD_NAME,
    value,
    inline: false,
  }));
}

module.exports = {
  ROSTER_ICON_UNKNOWN,
  buildPickerClosedEmbed,
  chunkLinesIntoFields,
  countRoles,
  formatClassIcon,
  formatSavedCharacterLine,
  resolveRosterIcon,
};
