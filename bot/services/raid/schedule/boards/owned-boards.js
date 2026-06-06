/**
 * services/raid/schedule/owned-boards.js
 * Pure shaping for active-board pickers: turn RaidEvent docs into sorted,
 * render-ready rows. No I/O - the Mongo query + Discord option build live in
 * the handlers. Kept here so the sort/derived-count logic is unit-testable.
 *
 * Two consumers:
 *   - the board's "🗓 Board khác của lead" switcher (a creator's boards, one
 *     <=25-option select) -> shapeOwnedBoardOptions.
 *   - /raid-check's "📋 Đội đã xếp" dropdown (all active events guild-wide,
 *     spilled across several selects) -> shapeAllOwnedBoardRows + chunkBoardOptions.
 *
 * Counts are DERIVED via assignSlots (placement is never stored), matching how
 * the board embed itself reports comp/waitlist - one source of truth.
 */

"use strict";

const { assignSlots } = require("../slots/slots");

// Discord caps a select menu at 25 options.
const SWITCHER_OPTION_CAP = 25;

/**
 * Shape RaidEvent docs into render-ready rows: sorted by start time (soonest
 * first), with comp/waitlist counts derived live and the current board flagged.
 * UNCAPPED - the caller slices (single select) or chunks (overflow selects).
 * @param {Array} events - active RaidEvent docs (lean)
 * @param {string} currentEventId - the board a switcher lives on (flagged isCurrent); "" for none
 * @returns {Array<{eventId: string, raidKey: string, modeKey: string, channelId: string, creatorId: string, startAt: Date, title: string, compCount: number, partySize: number, waitlistCount: number, isCurrent: boolean}>}
 */
function shapeAllOwnedBoardRows(events, currentEventId) {
  const current = String(currentEventId);
  return (Array.isArray(events) ? events : [])
    .slice()
    // Soonest-first: the board most likely to need attention sits at the top.
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .map((event) => {
      const { support, dps, waitlist } = assignSlots(event.signups, {
        supSlots: event.supSlots,
        dpsSlots: event.dpsSlots,
      });
      const eventId = String(event._id);
      return {
        eventId,
        // Last 6 hex of the ObjectId - a stable, distinct short code per event
        // (same source as the board footer's id), shown in the picker label so
        // same-raid boards are tell-apart-able. No new field / migration.
        shortId: eventId.slice(-6),
        raidKey: event.raidKey,
        modeKey: event.modeKey,
        channelId: event.channelId,
        creatorId: event.creatorId,
        startAt: event.startAt,
        title: event.title || "",
        compCount: support.length + dps.length,
        partySize: event.partySize,
        waitlistCount: waitlist.length,
        isCurrent: eventId === current,
      };
    });
}

/**
 * The board switcher's options: a creator's boards, capped at one select's
 * 25-option limit (the switcher is a single dropdown).
 * @param {Array} events - active RaidEvent docs (lean) for one creator
 * @param {string} currentEventId - the board the switcher lives on
 * @returns {Array} shaped rows (<= 25)
 */
function shapeOwnedBoardOptions(events, currentEventId) {
  return shapeAllOwnedBoardRows(events, currentEventId).slice(0, SWITCHER_OPTION_CAP);
}

/**
 * Split shaped rows into chunks of <= size, one per overflow select. Pure.
 * @param {Array} rows - shaped board rows
 * @param {number} [size=25] - max options per select (Discord's cap)
 * @returns {Array<Array>} array of chunks (each <= size); [] when no rows
 */
function chunkBoardOptions(rows, size = SWITCHER_OPTION_CAP) {
  const list = Array.isArray(rows) ? rows : [];
  const step = Math.max(1, Number(size) || SWITCHER_OPTION_CAP);
  const chunks = [];
  for (let i = 0; i < list.length; i += step) {
    chunks.push(list.slice(i, i + step));
  }
  return chunks;
}

module.exports = {
  shapeAllOwnedBoardRows,
  shapeOwnedBoardOptions,
  chunkBoardOptions,
  SWITCHER_OPTION_CAP,
};
