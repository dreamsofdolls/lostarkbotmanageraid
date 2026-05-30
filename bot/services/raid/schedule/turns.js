/**
 * services/raid/schedule/turns.js
 * Pure helpers for the lead-arranged multi-turn (bus) plan. A turn holds
 * signup discordIds; the same id may appear in multiple turns (a scarce
 * support busing several groups - that's the point). resolveTurnMembers
 * maps a turn's ids back to live signup records (dropping anyone who left
 * the pool) and tags each with role so the renderer can show class + role
 * + character per member. Membership is from the signup pool only - no
 * free-typed pugs (locked design decision).
 */

"use strict";

const { isSupportClass } = require("../../../models/Class");

/**
 * Append a new empty turn.
 * @param {Array} turns - current turns
 * @param {string} name - turn label (e.g. "Turn 1")
 * @returns {Array} new turns array
 */
function addTurn(turns, name) {
  return [...(Array.isArray(turns) ? turns : []), { name, memberIds: [] }];
}

/**
 * Replace one turn's members (deduped); other turns untouched.
 * @param {Array} turns
 * @param {number} index - turn to update
 * @param {string[]} memberIds - signup discordIds to set
 * @returns {Array} new turns array
 */
function setTurnMembers(turns, index, memberIds) {
  const unique = [...new Set(Array.isArray(memberIds) ? memberIds : [])];
  return (Array.isArray(turns) ? turns : []).map((turn, i) => ({
    name: turn.name,
    memberIds: i === index ? unique : [...(turn.memberIds || [])],
  }));
}

/**
 * Drop the turn at index.
 * @param {Array} turns
 * @param {number} index
 * @returns {Array} new turns array
 */
function removeTurn(turns, index) {
  return (Array.isArray(turns) ? turns : []).filter((_, i) => i !== index);
}

/**
 * Map a turn's memberIds to live signup records, dropping anyone no longer
 * in the pool and tagging each with role.
 * @param {Array} signups - event.signups
 * @param {object} turn - a turn sub-document
 * @returns {Array<{discordId: string, characterName: string, characterClass: string, characterItemLevel: number, role: "support"|"dps"}>}
 */
function resolveTurnMembers(signups, turn) {
  const byId = new Map((signups || []).map((s) => [s.discordId, s]));
  return (turn?.memberIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((s) => ({
      discordId: s.discordId,
      characterName: s.characterName,
      characterClass: s.characterClass,
      characterItemLevel: s.characterItemLevel,
      role: isSupportClass(s.characterClass) ? "support" : "dps",
    }));
}

module.exports = { addTurn, setTurnMembers, removeTurn, resolveTurnMembers };
