"use strict";

const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
} = require("../../../../utils/raid/tasks/side-tasks");

function capForReset(reset) {
  return reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
}

/**
 * Resolve the cycle-start epoch ms for a task reset type. Daily and weekly
 * tasks anchor to their reset boundary; scheduled or other reset types
 * track by event key and return 0.
 * @param {string} reset - "daily" | "weekly" | "scheduled"
 * @param {{dailyResetStartMs: Function, weekResetStartMs: Function}} deps
 * @returns {number}
 */
function cycleStartForReset(reset, { dailyResetStartMs, weekResetStartMs }) {
  if (reset === "daily") return dailyResetStartMs();
  if (reset === "weekly") return weekResetStartMs();
  return 0;
}

module.exports = {
  capForReset,
  cycleStartForReset,
};
