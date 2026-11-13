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

test("/raid-schedule-preview is retired: not registered, routed or dispatched", () => {
  const registeredCommandNames = commands.map((command) => command.toJSON().name);

  assert.ok(!registeredCommandNames.includes("raid-schedule-preview"));
  assert.ok(!RAID_COMMAND_NAMES.includes("raid-schedule-preview"));
  assert.ok(!commandsTest.getRaidCommandDispatchNames().includes("raid-schedule-preview"));
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

test("roster picker selects route to the roster component handlers", async () => {
  const calls = { add: 0, edit: 0 };
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
      handleRaidTaskAutocomplete: noop,
      handleRaidGoldEarnerAutocomplete: noop,
      handleAddRosterButton: async () => { calls.add += 1; },
      handleEditRosterButton: async () => { calls.edit += 1; },
    },
  });
  const selectInteraction = (customId) => ({
    id: customId,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    customId,
  });

  await router.handle(selectInteraction("add-roster:pick:s"));
  await router.handle(selectInteraction("edit-roster:pick:s"));

  assert.deepEqual(calls, { add: 1, edit: 1 });
});

test("the generic error reply reads the user's language through the passed UserModel", async (t) => {
  t.mock.method(console, "error", () => {});
  const { clearUserLanguageCache, t: translate } = require("../bot/services/i18n");
  clearUserLanguageCache();
  const { EmbedBuilder } = require("discord.js");
  const replies = [];
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    EmbedBuilder,
    UserModel: { findOne: () => ({ lean: async () => ({ language: "en" }) }) },
    handlers: {
      handleRaidManagementCommand: async () => {
        throw new Error("unexpected failure");
      },
    },
  });

  await router.handle({
    id: "registry-generic-error",
    commandName: "raid-status",
    user: { id: "registry-user-en" },
    isChatInputCommand: () => true,
    isRepliable: () => true,
    reply: async (payload) => replies.push(payload),
  });

  // The registry passes EmbedBuilder through, so the card renders in English.
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].embeds[0].toJSON().title, new RegExp(`${translate("common.notice.commandFailedTitle", "en")}$`));
  clearUserLanguageCache();
});

test("/raid-server autocomplete routes to its handler", async () => {
  let served = 0;
  const noop = async () => {};
  const handlers = new Proxy(
    { handleRaidServerAutocomplete: async () => { served += 1; } },
    { get: (target, key) => target[key] ?? noop },
  );
  const router = createRaidInteractionRouter({ MessageFlags: { Ephemeral: 64 }, handlers });
  await router.handle({
    id: "raid-server-autocomplete",
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    commandName: "raid-server",
    respond: noop,
  });
  assert.equal(served, 1);
});
