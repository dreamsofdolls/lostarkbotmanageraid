"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const { createRaidChannelCommand } = require("../bot/handlers/raid/channel");
const { clearUserLanguageCache } = require("../bot/services/i18n");

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
