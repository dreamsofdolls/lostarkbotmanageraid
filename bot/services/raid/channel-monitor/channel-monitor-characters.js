/**
 * services/raid/channel-monitor/channel-monitor-characters.js
 * How the text-channel monitor matches a typed name to a roster character.
 * The write preflight, the receipt card and the channel messages share it so
 * all three agree on who a name means.
 */

"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { getCharacterClass, getCharacterName } = require("../../../utils/raid/common/shared");

/**
 * @param {unknown} value - a typed or stored character name
 * @returns {string} trimmed, lowercase lookup key
 */
function toCharacterLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Return every normalized name field that may identify a roster character.
 * @param {object} character - saved roster character
 * @returns {string[]} lowercase, trimmed lookup candidates
 */
function getAccessibleCharacterCandidates(character) {
  return [character?.charName, character?.name, character?.displayName]
    .map(toCharacterLookupKey)
    .filter(Boolean);
}

/**
 * Index an accessible-roster snapshot while preserving first-match precedence.
 * @param {Array<object>} accessibleAccounts - access-control account entries
 * @returns {Map<string, object>} normalized character name to routing metadata
 */
function buildAccessibleCharacterIndex(accessibleAccounts) {
  const byName = new Map();
  for (const entry of accessibleAccounts || []) {
    const chars = Array.isArray(entry.account?.characters) ? entry.account.characters : [];
    for (const character of chars) {
      const hit = { ...entry, character };
      for (const candidate of getAccessibleCharacterCandidates(character)) {
        // Preserve the former nested-loop rule: the first accessible match wins.
        if (!byName.has(candidate)) byName.set(candidate, hit);
      }
    }
  }
  return byName;
}

/**
 * @param {Map<string, object>} index - from buildAccessibleCharacterIndex
 * @param {unknown} name - the name as typed
 * @returns {object|null} the routing hit, with `character`
 */
function findAccessibleCharacter(index, name) {
  return index.get(toCharacterLookupKey(name)) || null;
}

/**
 * @param {string[]} names - names as typed
 * @returns {string[]} names in first-seen order, one per lookup key
 */
function uniqueNames(names) {
  const seen = new Set();
  return names.filter((name) => {
    const key = toCharacterLookupKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A character's name for a message: class icon plus its saved spelling, or
 * the typed name in bold when the roster does not hold it.
 * @param {Map<string, object>} index - from buildAccessibleCharacterIndex
 * @param {string} name - the name as typed or as returned by a write
 * @returns {string}
 */
function formatNamedCharacter(index, name) {
  const hit = findAccessibleCharacter(index, name);
  if (!hit) return `**${name}**`;
  const emoji = getClassEmoji(getCharacterClass(hit.character));
  return `${emoji ? `${emoji} ` : ""}**${getCharacterName(hit.character)}**`;
}

module.exports = {
  buildAccessibleCharacterIndex,
  findAccessibleCharacter,
  formatNamedCharacter,
  getAccessibleCharacterCandidates,
  toCharacterLookupKey,
  uniqueNames,
};
