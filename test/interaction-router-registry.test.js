"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RAID_COMMAND_NAMES } = require("../bot/app/interaction-router-registry");
const { commands } = require("../bot/commands");

test("interaction router allowlist includes /raid-bg", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-bg"));
});

test("interaction router allowlist includes every registered slash command", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name);
  const missingFromRouter = registeredCommandNames.filter(
    (name) => !RAID_COMMAND_NAMES.includes(name)
  );

  assert.deepEqual(missingFromRouter, []);
});
