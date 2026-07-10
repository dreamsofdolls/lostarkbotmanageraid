"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  createRaidCheckCommand,
} = require("../bot/handlers/raid-check");
const {
  clearUserLanguageCache,
} = require("../bot/services/i18n");

test("raid-check acknowledges before the first language lookup, including denied users", async () => {
  clearUserLanguageCache();
  const events = [];
  const User = {
    findOne() {
      return {
        lean: async () => {
          events.push("language");
          return { language: "vi" };
        },
      };
    },
  };
  const interaction = {
    user: { id: "denied-user" },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("edit");
    },
    reply: async () => {
      events.push("reply");
    },
  };
  const command = createRaidCheckCommand({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    isRaidLeader: () => false,
    RAID_REQUIREMENT_MAP: {},
  });

  await command.handleRaidCheckCommand(interaction);

  assert.deepEqual(events, ["defer", "language", "edit"]);
});

test("raid-check denied button acknowledges before the language lookup", async () => {
  clearUserLanguageCache();
  const events = [];
  const User = {
    findOne() {
      return {
        lean: async () => {
          events.push("language");
          return { language: "vi" };
        },
      };
    },
  };
  const interaction = {
    customId: "raid-check:view-tasks:user-1",
    user: { id: "denied-button-user" },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("edit");
    },
    reply: async () => {
      events.push("reply");
    },
  };
  const command = createRaidCheckCommand({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    isRaidLeader: () => false,
    RAID_REQUIREMENT_MAP: {},
  });

  await command.handleRaidCheckButton(interaction);

  assert.deepEqual(events, ["defer", "language", "edit"]);
});
