const User = require("./schema/user");
const { RAID_REQUIREMENTS } = require("./models/Raid");

const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

function getWeekKey(date = new Date()) {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNumber);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function isWednesdayMorning(date = new Date()) {
  return date.getDay() === 3 && date.getHours() >= 6;
}

async function resetWeekly(now = new Date()) {
  if (!isWednesdayMorning(now)) {
    return { skipped: true, reason: "Not Wednesday morning yet" };
  }

  const resetKey = getWeekKey(now);

  const users = await User.find({ weeklyResetKey: { $ne: resetKey } });
  let modifiedCount = 0;

  for (const user of users) {
    const accounts = Array.isArray(user.accounts) ? user.accounts : [];

    for (const account of accounts) {
      const characters = Array.isArray(account.characters) ? account.characters : [];

      for (const character of characters) {
        const assignedRaids = character.assignedRaids || {};
        for (const raidKey of RAID_GROUP_KEYS) {
          if (!assignedRaids[raidKey]) continue;

          const gateKeys = Object.keys(assignedRaids[raidKey] || {}).filter((gate) => /^G\d+$/i.test(gate));
          for (const gate of gateKeys) {
            if (!assignedRaids[raidKey][gate]) continue;
            assignedRaids[raidKey][gate].completedDate = null;
          }
        }

        const tasks = Array.isArray(character.tasks) ? character.tasks : [];
        for (const task of tasks) {
          task.completions = 0;
          task.completionDate = null;
        }

        character.assignedRaids = assignedRaids;
        character.tasks = tasks;
      }
    }

    user.weeklyResetKey = resetKey;
    await user.save();
    modifiedCount += 1;
  }

  return {
    skipped: false,
    resetKey,
    matchedCount: users.length,
    modifiedCount,
  };
}

function startWeeklyResetJob() {
  const run = async () => {
    try {
      const result = await resetWeekly();
      if (!result.skipped) {
        console.log(
          `[weekly-reset] resetKey=${result.resetKey} matched=${result.matchedCount} modified=${result.modifiedCount}`
        );
      }
    } catch (error) {
      console.error("[weekly-reset] Failed to reset raid completion:", error.message);
    }
  };

  run().catch(() => {});
  return setInterval(run, 30 * 60 * 1000);
}

module.exports = {
  resetWeekly,
  startWeeklyResetJob,
};
