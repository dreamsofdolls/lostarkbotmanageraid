/**
 * services/raid/schedule/auto-clear.js
 * Choose the auto-clear write targets when a /raid-schedule event ends.
 * Each confirmed or late signup -> a clear of (raidKey, modeKey, all
 * gates) on that signup's OWN character (consent = the act of signing up).
 * Pure target selection only; the actual write goes through the /raid-set
 * path in a later phase.
 */

"use strict";

const { getGatesForRaid } = require("../../../domain/raid-catalog");

// Only players who held a slot (confirmed + late) get a clear written.
const CLEAR_STATUSES = new Set(["confirmed", "late"]);

/**
 * Build the list of clear-write targets for a finished event.
 * @param {object} event - RaidEvent doc (needs raidKey, modeKey, signups[])
 * @returns {Array<{discordId: string, accountName: string, characterName: string, raidKey: string, modeKey: string, gates: string[]}>}
 */
function selectAutoClearTargets(event) {
  if (!event || !Array.isArray(event.signups)) return [];
  const gates = getGatesForRaid(event.raidKey);
  return event.signups
    .filter((s) => CLEAR_STATUSES.has(s.status))
    .map((s) => ({
      discordId: s.discordId,
      accountName: s.accountName,
      characterName: s.characterName,
      raidKey: event.raidKey,
      modeKey: event.modeKey,
      gates,
    }));
}

module.exports = { selectAutoClearTargets, CLEAR_STATUSES };
