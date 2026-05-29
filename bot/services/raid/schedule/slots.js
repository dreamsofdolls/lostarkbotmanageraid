/**
 * services/raid/schedule/slots.js
 * Pure slot-assignment for the /raid-schedule board. Given the
 * slot-occupying signups (confirmed + late) and the recommended
 * support/dps counts, partition them into support / dps / waitlist by
 * join order. Overflow within a role spills to the waitlist; promotion
 * looks up the first waitlisted signup of a freed role.
 */

"use strict";

// confirmed + late both hold a slot (a late player is still in the comp).
const SLOT_STATUSES = new Set(["confirmed", "late"]);

/**
 * Partition signups into filled slots + waitlist.
 * @param {Array<{discordId: string, role: "support"|"dps", status: string, joinedAt: number}>} signups
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @returns {{support: Array, dps: Array, waitlist: Array}}
 */
function assignSlots(signups, { supSlots, dpsSlots }) {
  const occupying = (signups || [])
    .filter((s) => SLOT_STATUSES.has(s.status))
    .slice()
    .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt));

  const support = [];
  const dps = [];
  const waitlist = [];
  for (const s of occupying) {
    if (s.role === "support" && support.length < supSlots) support.push(s);
    else if (s.role === "dps" && dps.length < dpsSlots) dps.push(s);
    else waitlist.push(s);
  }
  return { support, dps, waitlist };
}

/**
 * First waitlisted signup of a given role (the one a freed slot promotes).
 * @param {Array} signups - all signups
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @param {"support"|"dps"} role - the role whose slot just freed
 * @returns {object|null} the promotable signup, or null
 */
function nextWaitlistPromotion(signups, counts, role) {
  const { waitlist } = assignSlots(signups, counts);
  return waitlist.find((s) => s.role === role) || null;
}

/**
 * Who got pulled into the comp between two states. Because placement is
 * derived (no stored slot index), a leave/vacate implicitly promotes the
 * next waitlister - this diff finds them so the handler can ping. Usually
 * 0 or 1 entries.
 * @param {Array} before - signups before the mutation
 * @param {Array} after - signups after the mutation
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @returns {Array} signups now in the comp that were not before
 */
function detectPromotion(before, after, counts) {
  const compIds = (list) => {
    const { support, dps } = assignSlots(list, counts);
    return new Set([...support, ...dps].map((s) => s.discordId));
  };
  const beforeComp = compIds(before);
  const afterSlots = assignSlots(after, counts);
  return [...afterSlots.support, ...afterSlots.dps].filter(
    (s) => !beforeComp.has(s.discordId)
  );
}

module.exports = { assignSlots, nextWaitlistPromotion, detectPromotion, SLOT_STATUSES };
