/**
 * services/raid/schedule/slots/eligibility.js
 * Roster-aware eligibility for /raid-schedule signups. Derives a
 * character's role (support vs dps) from its class, checks whether it has
 * already cleared a raid in the event's reset week (all gates stamped), and flattens a
 * user's accounts into a per-character list with an item-level gate flag
 * + deficit so the signup picker can show eligible chars selectable and
 * ineligible chars greyed with the missing iLvl.
 */

"use strict";

const { isSupportClass } = require("../../../../models/Class");
const { getGatesForRaid } = require("../../../../domain/raid-catalog");
const { weeklyResetStartMs } = require("../../../../utils/raid/schedule/reset-windows");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Derive a slot role from a class display name.
 * @param {string} className - e.g. "Bard", "Berserker"
 * @returns {"support"|"dps"}
 */
function deriveRole(className) {
  return isSupportClass(className) ? "support" : "dps";
}

/**
 * Whether a character has cleared every gate of a raid in a reset week.
 * With a week start, only completions inside that week count, so this
 * week's clear does not block next week's event and a stamp the weekly
 * reset job has not cleared yet does not block this week's. Without one,
 * any positive stamp counts.
 * @param {object} character - roster character sub-document
 * @param {string} raidKey - a raid key of `RAID_ORDER` (bot/domain/raid-catalog.js)
 * @param {number} [weekStartMs] - start of the event's reset week
 * @returns {boolean}
 */
function hasClearedRaid(character, raidKey, weekStartMs = 0) {
  const assigned = character?.assignedRaids?.[raidKey];
  if (!assigned) return false;
  const inWeek = weekStartMs > 0
    ? (stamp) => stamp >= weekStartMs && stamp < weekStartMs + WEEK_MS
    : (stamp) => stamp > 0;
  return getGatesForRaid(raidKey).every(
    (gate) => inWeek(Number(assigned?.[gate]?.completedDate) || 0)
  );
}

/**
 * Flatten a user's accounts into a per-character eligibility list.
 * @param {Array} accounts - User.accounts[]
 * @param {{raidKey: string, minItemLevel: number, startAt?: Date}} target - the event's raid, iLvl floor
 *   and start; alreadyCleared looks at the reset week the event starts in
 * @returns {Array<{characterId: string, accountName: string, name: string, className: string, itemLevel: number, role: "support"|"dps", eligible: boolean, deficit: number, alreadyCleared: boolean}>}
 */
function listEligibleCharacters(accounts, { raidKey, minItemLevel, startAt = null }) {
  const weekStartMs = startAt ? weeklyResetStartMs(startAt) : 0;
  const rows = [];
  for (const account of accounts || []) {
    for (const ch of account?.characters || []) {
      const itemLevel = Number(ch?.itemLevel) || 0;
      const eligible = itemLevel >= minItemLevel;
      rows.push({
        characterId: ch.id,
        accountName: account.accountName,
        name: ch.name,
        className: ch.class,
        itemLevel,
        role: deriveRole(ch.class),
        eligible,
        deficit: eligible ? 0 : minItemLevel - itemLevel,
        alreadyCleared: hasClearedRaid(ch, raidKey, weekStartMs),
      });
    }
  }
  return rows;
}

/**
 * Split iLvl-eligible rows into the ones still selectable for a signup (not
 * yet cleared this week) and flag whether the ONLY reason nothing is
 * selectable is that every eligible character already cleared. A cleared
 * character has nothing to gain from signing up for a normal (non-bus) clear,
 * so it is hidden; the allCleared flag lets callers say "all cleared" instead
 * of the misleading "no character at iLvl".
 * @param {Array<{alreadyCleared: boolean}>} eligibleRows - rows already filtered to iLvl-eligible
 * @returns {{selectable: Array, allCleared: boolean}}
 */
function partitionSelectable(eligibleRows) {
  const list = Array.isArray(eligibleRows) ? eligibleRows : [];
  const selectable = list.filter((row) => !row.alreadyCleared);
  return { selectable, allCleared: list.length > 0 && selectable.length === 0 };
}

module.exports = { deriveRole, hasClearedRaid, listEligibleCharacters, partitionSelectable };
