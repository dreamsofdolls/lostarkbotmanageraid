/**
 * services/raid/schedule/owned-boards.js
 * Pure shaping for the "🗓 Board khác của lead" switcher on a signup board: turn
 * a creator's active RaidEvent docs into sorted, capped, render-ready rows. No
 * I/O - the Mongo query (by creatorId) + Discord option build live in the
 * handler. Kept here so the sort/cap/derived-count logic is unit-testable.
 *
 * Counts are DERIVED via assignSlots (placement is never stored), matching how
 * the board embed itself reports comp/waitlist - one source of truth.
 */

"use strict";

const { assignSlots } = require("./slots");

// Discord caps a select menu at 25 options.
const SWITCHER_OPTION_CAP = 25;

/**
 * Shape a creator's active boards into switcher rows: sorted by start time
 * (soonest first), capped at 25, with comp/waitlist counts derived live and
 * the current board flagged. The handler turns these into Discord options.
 * @param {Array} events - active RaidEvent docs (lean) for one creator
 * @param {string} currentEventId - the board the switcher lives on (flagged isCurrent)
 * @returns {Array<{eventId: string, raidKey: string, modeKey: string, channelId: string, startAt: Date, title: string, compCount: number, partySize: number, waitlistCount: number, isCurrent: boolean}>}
 */
function shapeOwnedBoardOptions(events, currentEventId) {
  const current = String(currentEventId);
  return (Array.isArray(events) ? events : [])
    .slice()
    // Soonest-first: the board most likely to need attention sits at the top.
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .slice(0, SWITCHER_OPTION_CAP)
    .map((event) => {
      const { support, dps, waitlist } = assignSlots(event.signups, {
        supSlots: event.supSlots,
        dpsSlots: event.dpsSlots,
      });
      return {
        eventId: String(event._id),
        raidKey: event.raidKey,
        modeKey: event.modeKey,
        channelId: event.channelId,
        startAt: event.startAt,
        title: event.title || "",
        compCount: support.length + dps.length,
        partySize: event.partySize,
        waitlistCount: waitlist.length,
        isCurrent: String(event._id) === current,
      };
    });
}

module.exports = { shapeOwnedBoardOptions, SWITCHER_OPTION_CAP };
