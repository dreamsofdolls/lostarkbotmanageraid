"use strict";

const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
} = require("../../../../utils/raid/tasks/side-tasks");

function capForReset(reset) {
  return reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
}

function cycleStartForReset(reset, { dailyResetStartMs, weekResetStartMs }) {
  return reset === "daily" ? dailyResetStartMs() : weekResetStartMs();
}

module.exports = {
  capForReset,
  cycleStartForReset,
};
