"use strict";

/**
 * utils/raid/common/changed-characters.js
 *
 * Character cards for the cards that report what a sync just wrote, in the
 * /raid-status character grammar: `{class icon} {name} · {ilvl}`, one
 * formatRaidStatusLine row per raid, two cards per line. The Local Sync
 * card and the Bible sync report both build their bodies from these, so
 * the two sync results read the same.
 */

const { getClassEmoji } = require("../../../models/Class");
const { pack2Columns } = require("./shared");
const { formatRaidStatusLine, getStatusRaidsForCharacter } = require("./character");

const EMBED_FIELD_LIMIT = 25;
// Discord rejects an empty field value; a header field carries its text in
// the name.
const BLANK_FIELD_VALUE = "​";

/**
 * A character card in the /raid-status grammar.
 * @param {object} character - roster character (name, itemLevel, class)
 * @param {string[]} lines - body rows
 * @returns {{name: string, value: string, inline: boolean}}
 */
function buildCharacterStatusField(character, lines) {
  const emoji = getClassEmoji(character.class || character.className);
  return {
    name: `${emoji ? `${emoji} ` : ""}${character.name} · ${Number(character.itemLevel) || 0}`,
    value: lines.join("\n"),
    inline: true,
  };
}

/**
 * Status rows for the raids a sync wrote on this character, read from the
 * character after the sync so the counts match /raid-status.
 * @param {object} character - roster character after the sync
 * @param {Set<string>} touchedKeys - "raidKey::modeKey" pairs the sync wrote
 * @param {string} lang - locale
 * @returns {string[]} one formatRaidStatusLine row per touched raid
 */
function touchedRaidLines(character, touchedKeys, lang) {
  return getStatusRaidsForCharacter(character)
    .filter((raid) => touchedKeys.has(`${raid.raidKey}::${raid.modeKey}`))
    .map((raid) => formatRaidStatusLine(raid, lang));
}

/**
 * Append one group (an optional header, then its characters two per line)
 * while it fits under Discord's 25-field embed cap. A group without room
 * for its header and one line is left out; the counts in the headers and
 * the summary still give the totals.
 * @param {object[]} fields - embed fields collected so far, extended in place
 * @param {object|null} header - non-inline group header field
 * @param {object[]} charFields - inline character fields
 * @returns {void}
 */
function appendGroupFields(fields, header, charFields) {
  const headerCost = header ? 1 : 0;
  // pack2Columns emits three fields per line: two characters and a spacer.
  if (fields.length + headerCost + 3 > EMBED_FIELD_LIMIT) return;
  if (header) fields.push(header);
  const lines = pack2Columns(charFields);
  for (let index = 0; index < lines.length; index += 3) {
    if (fields.length + 3 > EMBED_FIELD_LIMIT) break;
    fields.push(...lines.slice(index, index + 3));
  }
}

module.exports = {
  BLANK_FIELD_VALUE,
  EMBED_FIELD_LIMIT,
  appendGroupFields,
  buildCharacterStatusField,
  touchedRaidLines,
};
