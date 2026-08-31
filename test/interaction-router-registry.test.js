"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_COMMAND_NAMES,
  createRaidInteractionRouter,
} = require("../bot/app/interaction-router-registry");
const commandModule = require("../bot/commands");
const {
  commands,
  __test: commandsTest,
} = commandModule;

test("interaction router allowlist includes /raid-bg", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-bg"));
});

test("interaction router allowlist includes /raid-schedule-preview", () => {
  assert.ok(RAID_COMMAND_NAMES.includes("raid-schedule-preview"));
  assert.ok(!RAID_COMMAND_NAMES.includes("raid-schedule"));
});

test("raid-sync is no longer registered as a standalone slash command", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name);

  assert.ok(!registeredCommandNames.includes("raid-sync"));
  assert.ok(!RAID_COMMAND_NAMES.includes("raid-sync"));
  assert.ok(!commandsTest.getRaidCommandDispatchNames().includes("raid-sync"));
});

test("interaction router allowlist includes every registered slash command", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name);
  const missingFromRouter = registeredCommandNames.filter(
    (name) => !RAID_COMMAND_NAMES.includes(name)
  );

  assert.deepEqual(missingFromRouter, []);
});

test("registered slash commands, router allowlist, and dispatcher stay aligned", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name).sort();
  const routedCommandNames = [...RAID_COMMAND_NAMES].sort();
  const dispatchedCommandNames = commandsTest.getRaidCommandDispatchNames().sort();

  assert.deepEqual(routedCommandNames, registeredCommandNames);
  assert.deepEqual(dispatchedCommandNames, registeredCommandNames);
});

test("raid-schedule-preview definition derives party size from raid instead of exposing size", () => {
  const command = commands.find((entry) => entry.toJSON().name === "raid-schedule-preview");
  assert.ok(command);
  const json = command.toJSON();
  const create = json.options.find((option) => option.name === "create");
  assert.ok(create);
  const optionNames = create.options.map((option) => option.name);
  assert.deepEqual(optionNames, [
    "raid",
    "mode",
    "when",
    "skip_notify",
    "auto_lock",
    "title",
  ]);
});

test("raid-schedule-preview show exposes an optional action choice (resurface / turnplan)", () => {
  const command = commands.find((entry) => entry.toJSON().name === "raid-schedule-preview");
  const json = command.toJSON();
  const show = json.options.find((option) => option.name === "show");
  assert.ok(show, "show subcommand exists");
  const action = (show.options || []).find((option) => option.name === "action");
  assert.ok(action, "show carries an action option");
  assert.equal(Boolean(action.required), false, "action is optional (default = resurface)");
  const values = (action.choices || []).map((choice) => choice.value).sort();
  assert.deepEqual(values, ["resurface", "turnplan"]);
});

test("raid-schedule-preview component routes dispatch through rse custom IDs", async () => {
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

test("raid-schedule-preview routes a User Select (add-member) through rse selects", async () => {
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
    handleRaidScheduleButton: noop,
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
    isUserSelectMenu: () => true,
    isButton: () => false,
    customId: "rse:adduser:abcdef123456",
  });

  assert.equal(selectCalls, 1);
});

test("Local Sync confirmation buttons route globally outside raid-status collectors", async () => {
  let localSyncCalls = 0;
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
    handleLocalSyncButton: async () => { localSyncCalls += 1; },
  };
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    handlers,
  });

  await router.handle({
    id: "local-sync-button-interaction",
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "local-sync:apply:preview-job-id",
  });

  assert.equal(localSyncCalls, 1);
});

test("Local Sync roster selects route through the exported console handler", async () => {
  let rosterSelectCalls = 0;
  const noop = async () => {};
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    handlers: {
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
      handleLocalSyncRosterSelect: async () => { rosterSelectCalls += 1; },
    },
  });

  await router.handle({
    id: "local-sync-roster-interaction",
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    customId: "local-sync:roster:preview-job-id",
  });

  assert.equal(rosterSelectCalls, 1);
  assert.equal(typeof commandModule.handleLocalSyncRosterSelect, "function");
});
