"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../bot/models/user");
const RaidEvent = require("../bot/models/RaidEvent");
const {
  startWeeklyResetJob,
} = require("../bot/services/raid/schedulers/weekly-reset");

test("weekly-reset scheduler skips an interval while the previous tick is running", async () => {
  const originalUserFind = User.find;
  const originalRaidEventFind = RaidEvent.find;
  const originalSetInterval = global.setInterval;
  const originalWarn = console.warn;
  let intervalFn = null;
  let releaseFirstTick = null;
  let userFindCalls = 0;
  let markPurgeReached = null;
  const firstTick = new Promise((resolve) => {
    releaseFirstTick = resolve;
  });
  const purgeReached = new Promise((resolve) => {
    markPurgeReached = resolve;
  });

  User.find = () => ({
    select: () => ({
      lean: () => {
        userFindCalls += 1;
        return userFindCalls === 1 ? firstTick : Promise.resolve([]);
      },
    }),
  });
  RaidEvent.find = () => {
    markPurgeReached();
    return {
      select: () => ({ lean: async () => [] }),
    };
  };
  global.setInterval = (fn, ms) => {
    intervalFn = fn;
    return { ms };
  };
  console.warn = () => {};

  try {
    const handle = startWeeklyResetJob(null);
    assert.equal(typeof intervalFn, "function");
    assert.equal(handle.ms, 30 * 60 * 1000);
    assert.equal(userFindCalls, 1);

    await intervalFn();
    assert.equal(userFindCalls, 1);

    releaseFirstTick([]);
    await purgeReached;
    await new Promise((resolve) => setImmediate(resolve));
    await intervalFn();
    assert.equal(userFindCalls, 2);
  } finally {
    User.find = originalUserFind;
    RaidEvent.find = originalRaidEventFind;
    global.setInterval = originalSetInterval;
    console.warn = originalWarn;
    releaseFirstTick([]);
  }
});
