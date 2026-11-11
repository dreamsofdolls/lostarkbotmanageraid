"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deferOrWarn } = require("../bot/utils/raid/common/shared");

test("deferOrWarn answers true for a defer that took, and logs nothing", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await deferOrWarn("[raid-status] local-refresh", Promise.resolve()), true);
  assert.equal(warn.mock.callCount(), 0);
});

test("deferOrWarn answers false for a failed defer and logs it under its label", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const failed = Promise.reject(Object.assign(new Error("Unknown interaction"), { code: 10062 }));
  assert.equal(await deferOrWarn("[raid-status] local-refresh", failed), false);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [
    ["[raid-status] local-refresh defer failed:", "Unknown interaction"],
  ]);
});

test("deferOrWarn logs a rejection that is not an Error as it is", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await deferOrWarn("[raid-check all] non-owner", Promise.reject("gone")), false);
  assert.deepEqual(warn.mock.calls[0].arguments, ["[raid-check all] non-owner defer failed:", "gone"]);
});
