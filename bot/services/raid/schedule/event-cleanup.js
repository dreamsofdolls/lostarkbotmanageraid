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

// An event left un-finished (not "cleared") this long after its start is
// treated as abandoned and purged early, without waiting for the weekly reset.
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Whether an event is stale enough to purge. Two rules:
 *   1. startAt before the most recent weekly reset (any status) - the raid week
 *      has passed.
 *   2. startAt more than 24h ago AND not marked done (status !== "cleared") -
 *      an abandoned event the lead never ended. Only checked when nowMs is given.
 * Missing/invalid startAt is treated as NOT stale - never delete blindly.
 * @param {object} event - a RaidEvent doc (needs startAt; status for rule 2)
 * @param {number} boundaryMs - epoch ms of the most recent weekly reset
 * @param {number} [nowMs] - current epoch ms; enables rule 2 when finite
 * @returns {boolean}
 */
function isStaleEvent(event, boundaryMs, nowMs) {
  const start = event && event.startAt != null ? new Date(event.startAt).getTime() : NaN;
  if (!Number.isFinite(start)) return false;
  if (start < boundaryMs) return true; // rule 1: before the weekly reset
  if (Number.isFinite(nowMs) && event.status !== "cleared" && start < nowMs - ABANDONED_AFTER_MS) {
    return true; // rule 2: 24h past start + never marked done
  }
  return false;
}

/**
 * Delete every raid event whose startAt is before the boundary. The DB delete
 * happens before any board message delete so a Mongo failure cannot leave an
 * open/locked ghost event whose board has vanished. Board deletion remains
 * best-effort after the docs are gone.
 * @param {{RaidEvent: object, client: object, boundaryMs: number, nowMs?: number}} deps
 * @returns {Promise<{deleted: number, boardsDeleted: number}>}
 */
async function purgeStaleRaidEvents({ RaidEvent, client, boundaryMs, nowMs }) {
  // Rule 1 (weekly boundary) always; rule 2 (24h abandoned) when nowMs is given.
  const orConds = [{ startAt: { $lt: new Date(boundaryMs) } }];
  if (Number.isFinite(nowMs)) {
    orConds.push({
      startAt: { $lt: new Date(nowMs - ABANDONED_AFTER_MS) },
      status: { $ne: "cleared" },
    });
  }
  const query = orConds.length > 1 ? { $or: orConds } : orConds[0];
  let stale;
  try {
    stale = await RaidEvent.find(query)
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
