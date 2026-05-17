"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RAID_COMMAND_NAMES } = require("../bot/app/interaction-router-registry");

test("interaction router allowlist includes /raid-bg", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-bg"));
});
