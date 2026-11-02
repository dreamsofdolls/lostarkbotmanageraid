"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../bot/models/user");
const {
  startWeeklyResetJob,
} = require("../bot/services/raid/schedulers/weekly-reset");

// Lets the released tick run to completion: it only awaits stubbed promises.
async function drainImmediates(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("weekly-reset scheduler skips an interval while the previous tick is running", async () => {
  const originalUserFind = User.find;
  const originalSetInterval = global.setInterval;
  const originalWarn = console.warn;
  let intervalFn = null;
  let releaseFirstTick = null;
  let userFindCalls = 0;
  const firstTick = new Promise((resolve) => {
    releaseFirstTick = resolve;
  });

  User.find = () => ({
    select: () => ({
      lean: () => {
        userFindCalls += 1;
        return userFindCalls === 1 ? firstTick : Promise.resolve([]);
      },
    }),
  });
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
    await drainImmediates();
    await intervalFn();
    assert.equal(userFindCalls, 2);
  } finally {
    User.find = originalUserFind;
    global.setInterval = originalSetInterval;
    console.warn = originalWarn;
    releaseFirstTick([]);
  }
});
