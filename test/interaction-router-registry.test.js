"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_COMMAND_NAMES,
  createRaidInteractionRouter,
} = require("../bot/app/interaction-router-registry");
const { commands } = require("../bot/commands");

test("interaction router allowlist includes /raid-bg", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-bg"));
});

test("interaction router allowlist includes /raid-schedule", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-schedule"));
});

test("interaction router allowlist includes every registered slash command", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name);
  const missingFromRouter = registeredCommandNames.filter(
    (name) => !RAID_COMMAND_NAMES.includes(name)
  );

  assert.deepEqual(missingFromRouter, []);
});

test("raid-schedule definition exposes the create options from the spec", () => {
  const command = commands.find((entry) => entry.toJSON().name === "raid-schedule");
  assert.ok(command);
  const json = command.toJSON();
  const create = json.options.find((option) => option.name === "create");
  assert.ok(create);
  const optionNames = create.options.map((option) => option.name);
  assert.deepEqual(optionNames, [
    "raid",
    "mode",
    "size",
    "when",
    "auto_lock",
    "title",
  ]);
});

test("raid-schedule component routes dispatch through rse custom IDs", async () => {
  let buttonCalls = 0;
  let selectCalls = 0;
  const noop = async () => {};
  const handlers = {
    handleRaidManagementCommand: noop,
    handleRaidHelpSelect: noop,
    handleRaidLanguageSelect: noop,
    handleRaidSetAutocomplete: noop,
    handleEditRosterAutocomplete: noop,
    handleRemoveRosterAutocomplete: noop,
    handleRaidChannelAutocomplete: noop,
    handleRaidAutoManageAutocomplete: noop,
    handleRaidAnnounceAutocomplete: noop,
    handleRaidTaskAutocomplete: noop,
    handleRaidGoldEarnerAutocomplete: noop,
    handleRaidScheduleButton: async () => { buttonCalls += 1; },
    handleRaidScheduleSelect: async () => { selectCalls += 1; },
  };
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    handlers,
  });

  await router.handle({
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "rse:join:abcdef123456",
  });
  await router.handle({
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    customId: "rse:pick:abcdef123456",
  });

  assert.equal(buttonCalls, 1);
  assert.equal(selectCalls, 1);
});
