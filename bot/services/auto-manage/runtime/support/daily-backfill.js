"use strict";

const {
  getTargetVNDayKey,
} = require("../../../../utils/raid/schedule/artist-clock");

const DAY_MS = 24 * 60 * 60 * 1000;

function getAutoManageDailyContext(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  return {
    currentDayKey: getTargetVNDayKey(instant),
    targetDayKey: getTargetVNDayKey(new Date(instant.getTime() - DAY_MS)),
  };
}

function buildMissingRaidStatusDayFilter({ currentDayKey, targetDayKey }) {
  return {
    lastRaidStatusOpenedDayKey: { $nin: [targetDayKey, currentDayKey] },
    lastAutoManageDailyAttemptDayKey: { $ne: targetDayKey },
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
  DAY_MS,
  getAutoManageDailyContext,
  buildMissingRaidStatusDayFilter,
  markRaidStatusOpenedDay,
};
