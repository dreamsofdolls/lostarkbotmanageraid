"use strict";

const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");

const SIDE_TASK_RESET_TICK_MS = 30 * 60 * 1000;

/**
 * Build task resets that invalidate older User document snapshots.
 * @param {object} deps - User model and daily/weekly reset boundaries
 * @returns {object} reset operations and scheduler lifecycle
 */
function createSideTaskResetService({
  User,
  dailyResetStartMs,
  weekResetStartMs,
}) {
  async function resetExpiredSideTasks(now = new Date()) {
    const dailyStart = dailyResetStartMs(now);
    const weeklyStart = weekResetStartMs(now);

    const dailyResult = await User.updateMany(
      {
        "accounts.characters.sideTasks": {
          $elemMatch: { reset: "daily", lastResetAt: { $lt: dailyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].characters.$[].sideTasks.$[task].completed": false,
          "accounts.$[].characters.$[].sideTasks.$[task].lastResetAt": dailyStart,
        },
        $inc: { __v: 1 },
      },
      {
        arrayFilters: [
          { "task.reset": "daily", "task.lastResetAt": { $lt: dailyStart } },
        ],
      }
    );

    const weeklyResult = await User.updateMany(
      {
        "accounts.characters.sideTasks": {
          $elemMatch: { reset: "weekly", lastResetAt: { $lt: weeklyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].characters.$[].sideTasks.$[task].completed": false,
          "accounts.$[].characters.$[].sideTasks.$[task].lastResetAt": weeklyStart,
        },
        $inc: { __v: 1 },
      },
      {
        arrayFilters: [
          { "task.reset": "weekly", "task.lastResetAt": { $lt: weeklyStart } },
        ],
      }
    );

    const sharedDailyResult = await User.updateMany(
      {
        "accounts.sharedTasks": {
          $elemMatch: { reset: "daily", lastResetAt: { $lt: dailyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].sharedTasks.$[task].completed": false,
          "accounts.$[].sharedTasks.$[task].completedAt": null,
          "accounts.$[].sharedTasks.$[task].lastResetAt": dailyStart,
        },
        $inc: { __v: 1 },
      },
      {
        arrayFilters: [
          { "task.reset": "daily", "task.lastResetAt": { $lt: dailyStart } },
        ],
      }
    );

    const sharedWeeklyResult = await User.updateMany(
      {
        "accounts.sharedTasks": {
          $elemMatch: { reset: "weekly", lastResetAt: { $lt: weeklyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].sharedTasks.$[task].completed": false,
          "accounts.$[].sharedTasks.$[task].completedAt": null,
          "accounts.$[].sharedTasks.$[task].lastResetAt": weeklyStart,
        },
        $inc: { __v: 1 },
      },
      {
        arrayFilters: [
          { "task.reset": "weekly", "task.lastResetAt": { $lt: weeklyStart } },
        ],
      }
    );

    return {
      dailyModified: dailyResult?.modifiedCount || 0,
      weeklyModified: weeklyResult?.modifiedCount || 0,
      sharedDailyModified: sharedDailyResult?.modifiedCount || 0,
      sharedWeeklyModified: sharedWeeklyResult?.modifiedCount || 0,
      dailyStart,
      weeklyStart,
    };
  }

  async function runSideTaskResetTick() {
    const report = await resetExpiredSideTasks();
    if (
      report.dailyModified > 0 ||
      report.weeklyModified > 0 ||
      report.sharedDailyModified > 0 ||
      report.sharedWeeklyModified > 0
    ) {
      console.log(
        `[side-task reset] daily=${report.dailyModified} weekly=${report.weeklyModified} sharedDaily=${report.sharedDailyModified} sharedWeekly=${report.sharedWeeklyModified}`
      );
    }
  }

  const runner = createNonOverlappingIntervalRunner({
    tickMs: SIDE_TASK_RESET_TICK_MS,
    runTick: runSideTaskResetTick,
    errorMessage: "[side-task reset] tick failed:",
  });

  return {
    SIDE_TASK_RESET_TICK_MS,
    resetExpiredSideTasks,
    startSideTaskResetScheduler: runner.start,
    getSideTaskSchedulerStartedAtMs: runner.getStartedAtMs,
  };
}

module.exports = {
  createSideTaskResetService,
};
