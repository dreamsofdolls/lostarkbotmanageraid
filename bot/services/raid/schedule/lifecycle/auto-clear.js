/**
 * services/raid/schedule/auto-clear.js
 * Choose the auto-clear write targets when a /raid-schedule event ends.
 * Only players who actually held a comp slot get credited - a confirmed
 * signup that overflowed to the waitlist did NOT raid, so it must NOT be
 * written. Targets are therefore the assignSlots-derived comp (support +
 * dps), not a raw status filter. Each target -> a clear of (raidKey,
 * modeKey, all gates) on that signup's OWN character (consent = the act
 * of signing up). Pure target selection only; the actual write goes
 * through the /raid-set path in a later phase.
 */

"use strict";

const { getGatesForRaid } = require("../../../../domain/raid-catalog");
const { assignSlots } = require("../slots/slots");

/**
 * Build the list of clear-write targets for a finished event. Credits
 * only the comp (filled support + dps slots); waitlist overflow and
 * tentative/absent are excluded.
 * @param {object} event - RaidEvent doc (needs raidKey, modeKey, supSlots, dpsSlots, signups[])
 * @returns {Array<{discordId: string, accountName: string, characterName: string, raidKey: string, modeKey: string, gates: string[]}>}
 */
function selectAutoClearTargets(event) {
  if (!event || !Array.isArray(event.signups)) return [];
  const { support, dps } = assignSlots(event.signups, {
    supSlots: event.supSlots,
    dpsSlots: event.dpsSlots,
  });
  const gates = getGatesForRaid(event.raidKey);
  return [...support, ...dps].map((s) => ({
    discordId: s.discordId,
    accountName: s.accountName,
    characterName: s.characterName,
    raidKey: event.raidKey,
    modeKey: event.modeKey,
    gates,
  }));
}

module.exports = { selectAutoClearTargets };
