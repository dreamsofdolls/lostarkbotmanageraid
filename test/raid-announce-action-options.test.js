"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidAnnounceCommandDefinition,
} = require("../bot/handlers/commands/command-definitions/admin");
const {
  createRaidAnnounceCommand,
} = require("../bot/handlers/raid/announce");
const {
  handleToggleAnnouncement,
} = require("../bot/handlers/raid/announce/toggle");
const {
  createRaidInteractionRouter,
} = require("../bot/app/interaction-router-registry");
const {
  announcementTypeEntry,
  announcementTypeKeys,
} = require("../bot/utils/raid/schedule/announcements");

test("raid-announce action is a static Discord dropdown with working on/off values", () => {
  const command = createRaidAnnounceCommandDefinition({
    announcementTypeKeys,
    announcementTypeEntry,
  }).toJSON();
  const action = command.options.find((option) => option.name === "action");

  assert.equal(action.autocomplete, undefined);
  assert.deepEqual(action.choices.map((choice) => choice.value), [
    "show",
    "on",
    "off",
    "set-channel",
    "clear-channel",
  ]);
  assert.equal(
    action.choices.find((choice) => choice.value === "on").name_localizations.vi,
    "Bật thông báo"
  );
  assert.equal(
    action.choices.find((choice) => choice.value === "off").name_localizations.vi,
    "Tắt thông báo"
  );
});

test("autocomplete on raid-announce from a stale client answers with an empty list", async () => {
  const noop = async () => {};
  const logged = [];
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    handlers: {
      handleRaidManagementCommand: noop,
      ...createRaidAnnounceCommand({ announcementTypeEntry }),
    },
    log: {
      warn: (...args) => logged.push(args),
      error: (...args) => logged.push(args),
    },
  });
  const responses = [];
  const autocomplete = (id, respond) => ({
    id,
    commandName: "raid-announce",
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    options: {
      getFocused: () => ({ name: "action", value: "" }),
      getString: () => null,
    },
    respond,
  });

  await router.handle(autocomplete("stale-ok", async (choices) => {
    responses.push(choices);
  }));
  await router.handle(autocomplete("stale-rejected", async () => {
    throw new Error("Unknown interaction");
  }));

  assert.deepEqual(responses, [[]]);
  assert.deepEqual(logged, [], "a rejected respond is swallowed, not routed to the error handler");
});

test("world-event reminder toggle writes the exact nested enabled field", async () => {
  for (const [action, enabled] of [["on", true], ["off", false]]) {
    const writes = [];
    const replies = [];
    await handleToggleAnnouncement({
      GuildConfig: {
        async findOneAndUpdate(filter, update, options) {
          writes.push({ filter, update, options });
        },
      },
      action,
      current: { enabled: !enabled, channelId: null },
      currentEntry: {
        subdocKey: "worldEventReminder",
        type: "world-event-reminder",
        typeLabel: "Chaos Gate / Field Boss · T-5m",
      },
      guildId: "guild-1",
      lang: "vi",
      async replyAnnounceNotice(payload) {
        replies.push(payload);
      },
    });

    assert.deepEqual(writes, [{
      filter: { guildId: "guild-1" },
      update: {
        $set: { "announcements.worldEventReminder.enabled": enabled },
      },
      options: { upsert: true, setDefaultsOnInsert: true },
    }]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].type, "success");
  }
});
