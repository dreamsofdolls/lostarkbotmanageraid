"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const { createRaidChannelCommand } = require("../bot/handlers/raid/channel");
const { clearUserLanguageCache } = require("../bot/services/i18n");
const { UI } = require("../bot/utils/raid/common/shared");

test("an unknown /raid-channel config action gets a reply instead of a silent timeout", async () => {
  clearUserLanguageCache();
  const replies = [];
  const { handleRaidChannelCommand } = createRaidChannelCommand({
    EmbedBuilder,
    PermissionFlagsBits,
    UI: {},
    User: { findOne: () => ({ lean: async () => ({ language: "en" }) }) },
    GuildConfig: {},
  });

  await handleRaidChannelCommand({
    guildId: "guild-1",
    user: { id: "admin-1" },
    memberPermissions: { has: () => true },
    options: { getString: () => "bogus" },
    reply: async (payload) => {
      replies.push(payload);
    },
  });

  assert.equal(replies.length, 1);
  const embed = replies[0].embeds[0].toJSON();
  assert.match(embed.title, /Unknown action/);
  assert.match(embed.description, /`bogus`/);
  assert.match(embed.description, /`schedule-off`/);
});

test("/raid-channel set acknowledges before it writes the channel and posts the welcome", async () => {
  clearUserLanguageCache();
  const events = [];
  const { handleRaidChannelCommand } = createRaidChannelCommand({
    EmbedBuilder,
    PermissionFlagsBits,
    UI,
    User: { findOne: () => ({ lean: async () => ({ language: "en" }) }) },
    GuildConfig: { findOneAndUpdate: async () => { events.push("write"); } },
    getCachedMonitorChannelId: () => null,
    setCachedMonitorChannelId: () => {},
    isTextMonitorEnabled: () => true,
    getMissingBotChannelPermissions: () => [],
    postRaidChannelWelcome: async () => {
      events.push("welcome");
      return { posted: false, pinned: false };
    },
  });

  await handleRaidChannelCommand({
    guildId: "guild-1",
    guild: { members: { me: {} } },
    user: { id: "admin-1" },
    client: { user: { id: "bot-1" } },
    memberPermissions: { has: () => true },
    options: {
      getString: () => "set",
      getChannel: () => ({ id: "chan-1" }),
    },
    deferReply: async () => { events.push("defer"); },
    reply: async () => { events.push("reply"); },
    editReply: async () => { events.push("edit"); },
  });

  assert.deepEqual(events, ["defer", "write", "welcome", "edit"]);
});
