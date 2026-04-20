const User = require("./schema/user");

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

  const result = await User.updateMany(
    { weeklyResetKey: { $ne: resetKey } },
    [
      {
        $set: {
          weeklyResetKey: resetKey,
          accounts: {
            $map: {
              input: { $ifNull: ["$accounts", []] },
              as: "account",
              in: {
                $mergeObjects: [
                  "$$account",
                  {
                    characters: {
                      $map: {
                        input: { $ifNull: ["$$account.characters", []] },
                        as: "character",
                        in: {
                          $mergeObjects: [
                            "$$character",
                            {
                              raids: {
                                $map: {
                                  input: { $ifNull: ["$$character.raids", []] },
                                  as: "raid",
                                  in: {
                                    $mergeObjects: ["$$raid", { isCompleted: false }],
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]
  );

  return {
    skipped: false,
    resetKey,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
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
