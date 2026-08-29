"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capForReset,
  cycleStartForReset,
} = require("../bot/handlers/raid/task/add/reset-policy");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
} = require("../bot/utils/raid/tasks/side-tasks");

test("raid task add reset policy selects the matching cap", () => {
  assert.equal(capForReset("daily"), TASK_CAP_DAILY);
  assert.equal(capForReset("weekly"), TASK_CAP_WEEKLY);
});

test("raid task add reset policy selects the matching cycle boundary", () => {
  const calls = [];
  const deps = {
    dailyResetStartMs: () => {
      calls.push("daily");
      return 111;
    },
    weekResetStartMs: () => {
      calls.push("weekly");
      return 222;
    },
  };

  assert.equal(cycleStartForReset("daily", deps), 111);
  assert.equal(cycleStartForReset("weekly", deps), 222);
  assert.deepEqual(calls, ["daily", "weekly"]);
});
