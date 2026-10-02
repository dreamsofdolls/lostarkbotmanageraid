"use strict";

const {
  getTargetVNDayKey,
} = require("../../../../utils/raid/schedule/artist-clock");

const DAY_MS = 24 * 60 * 60 * 1000;

// A new target key becomes available exactly at VN midnight. The availability
// filter uses it as the calendar gate while preserving lease/retry deadlines.
/**
 * @param {Date|number|string} [now] - Scheduler clock.
 * @returns {{currentDayKey: string, targetDayKey: string}} Current and completed VN days.
 */
function getAutoManageDailyContext(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  return {
    currentDayKey: getTargetVNDayKey(instant),
    targetDayKey: getTargetVNDayKey(new Date(instant.getTime() - DAY_MS)),
  };
}

async function markRaidStatusOpenedDay({
  User,
  discordId,
  lastOpenedDayKey = "",
  now = new Date(),
}) {
  if (!User || !discordId) return null;
  const dayKey = getTargetVNDayKey(now);
  if (lastOpenedDayKey === dayKey) return dayKey;
  await User.updateOne(
    {
      discordId,
      lastRaidStatusOpenedDayKey: { $ne: dayKey },
    },
    {
      $set: { lastRaidStatusOpenedDayKey: dayKey },
    }
  );
  return dayKey;
}

module.exports = {
  getAutoManageDailyContext,
  markRaidStatusOpenedDay,
};
