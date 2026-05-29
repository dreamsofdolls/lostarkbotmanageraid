"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getRaidPartySize } = require("../bot/domain/raid-catalog");

test("raid-schedule derives party size from the raid catalog", () => {
  assert.equal(getRaidPartySize("armoche"), 8);
  assert.equal(getRaidPartySize("kazeros"), 8);
  assert.equal(getRaidPartySize("serca"), 4);
});

test("raid-schedule rejects unknown raid party size metadata", () => {
  assert.throws(() => getRaidPartySize("unknown"), /unsupported raid party size/);
});
