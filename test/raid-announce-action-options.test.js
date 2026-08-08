"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidAnnounceCommandDefinition,
} = require("../bot/handlers/commands/command-definitions/admin");
const {
  createRaidAnnounceAutocompleteHandler,
} = require("../bot/handlers/raid/announce/autocomplete");
const {
  handleToggleAnnouncement,
} = require("../bot/handlers/raid/announce/toggle");
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

test("legacy raid-announce autocomplete answers without touching Mongo", async () => {
  let response = null;
  const handler = createRaidAnnounceAutocompleteHandler({
    normalizeName: (value) => String(value || "").trim().toLowerCase(),
    announcementTypeEntry,
    User: {
      findOne() {
        throw new Error("User DB must not be read by action autocomplete");
      },
    },
    GuildConfig: {
      findOne() {
        throw new Error("GuildConfig must not be read by action autocomplete");
      },
    },
  });
  const interaction = {
    locale: "vi",
    options: {
      getFocused: () => ({ name: "action", value: "" }),
      getString: (name) => name === "type" ? "world-event-reminder" : null,
    },
    async respond(choices) {
      response = choices;
    },
  };

  await handler(interaction);

  assert.deepEqual(response.map((choice) => choice.value), [
    "show",
    "on",
    "off",
    "set-channel",
    "clear-channel",
  ]);
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
