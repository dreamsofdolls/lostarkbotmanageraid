"use strict";

const {
  getTargetVNDayKey,
} = require("../../../../utils/raid/schedule/artist-clock");

const DAY_MS = 24 * 60 * 60 * 1000;

// Day keys label attempts for compatibility with persisted state. The separate
// daily-state filter enforces the rolling 24-hour interval and retry deadlines.
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
