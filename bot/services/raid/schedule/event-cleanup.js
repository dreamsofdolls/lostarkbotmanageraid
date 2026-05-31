/**
 * services/raid/schedule/event-cleanup.js
 * Auto-purge for stale /raid-schedule-preview events. A raid event whose
 * startAt is before the most recent weekly reset (Wed 10:00 UTC = 17:00 VN)
 * belongs to a finished raid cycle, so it is safe to delete its RaidEvent doc
 * and then best-effort remove the Discord board message. Wired into the
 * weekly-reset job tick, so it runs every 30 min and is catch-up safe +
 * idempotent (once purged there is nothing left until the boundary advances
 * next Wednesday).
 */

"use strict";

/**
 * Whether an event's raid week has passed (startAt strictly before boundary).
 * Missing/invalid startAt is treated as NOT stale - never delete blindly.
 * @param {object} event - a RaidEvent doc (needs startAt)
 * @param {number} boundaryMs - epoch ms of the most recent weekly reset
 * @returns {boolean}
 */
function isStaleEvent(event, boundaryMs) {
  const start = event && event.startAt != null ? new Date(event.startAt).getTime() : NaN;
  return Number.isFinite(start) && start < boundaryMs;
}

/**
 * Delete every raid event whose startAt is before the boundary. The DB delete
 * happens before any board message delete so a Mongo failure cannot leave an
 * open/locked ghost event whose board has vanished. Board deletion remains
 * best-effort after the docs are gone.
 * @param {{RaidEvent: object, client: object, boundaryMs: number}} deps
 * @returns {Promise<{deleted: number, boardsDeleted: number}>}
 */
async function purgeStaleRaidEvents({ RaidEvent, client, boundaryMs }) {
  let stale;
  try {
    stale = await RaidEvent.find({ startAt: { $lt: new Date(boundaryMs) } })
      .select("_id channelId messageId")
      .lean();
  } catch (error) {
    console.warn("[raid-schedule purge] query failed:", error?.message || error);
    return { deleted: 0, boardsDeleted: 0 };
  }
  if (!Array.isArray(stale) || stale.length === 0) {
    return { deleted: 0, boardsDeleted: 0 };
  }

  let deleted = 0;
  try {
    const res = await RaidEvent.deleteMany({ _id: { $in: stale.map((e) => e._id) } });
    deleted = res?.deletedCount || 0;
  } catch (error) {
    console.warn("[raid-schedule purge] deleteMany failed:", error?.message || error);
    return { deleted: 0, boardsDeleted: 0 };
  }
  if (deleted <= 0) {
    return { deleted: 0, boardsDeleted: 0 };
  }

  let boardsDeleted = 0;
  for (const ev of stale) {
    if (!ev.messageId || !ev.channelId || !client?.channels) continue;
    try {
      const channel = await client.channels.fetch(ev.channelId);
      const message = await channel?.messages?.fetch(ev.messageId);
      if (message) {
        await message.delete();
        boardsDeleted += 1;
      }
    } catch {
      // Board already gone, channel deleted, or missing perms - best-effort.
    }
  }
  return { deleted, boardsDeleted };
}

module.exports = { isStaleEvent, purgeStaleRaidEvents };
