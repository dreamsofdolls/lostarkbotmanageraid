"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { createCanvas } = require("@napi-rs/canvas");

const GuildConfig = require("../bot/models/guildConfig");
const { createRaidBgCommand } = require("../bot/handlers/raid/bg");
const { createRaidChannelCommand } = require("../bot/handlers/raid/channel");
const { createRaidChannelMonitorService } = require("../bot/services/raid/channel-monitor");

function makeUserModel(language = "en") {
  return {
    findOne: () => ({
      lean: async () => ({ language }),
    }),
    findOneAndUpdate: async () => ({}),
  };
}

function makePngBuffer() {
  const canvas = createCanvas(1600, 900);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#223344";
  ctx.fillRect(0, 0, 1600, 900);
  return canvas.toBuffer("image/png");
}

function arrayBufferFromBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("raid-channel set-bg-channel validates attach-file permissions", async () => {
  let capturedOptions = null;
  let savedUpdate = null;
  const channel = { id: "bg-channel" };
  const User = makeUserModel("en");
  const command = createRaidChannelCommand({
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    UI: { colors: { success: 0x57f287 }, icons: { done: "OK", reset: "RESET" } },
    User,
    GuildConfig: {
      findOneAndUpdate: async (_filter, update) => {
        savedUpdate = update;
      },
    },
    normalizeName: (value) => String(value || "").toLowerCase(),
    getCachedMonitorChannelId: () => null,
    setCachedMonitorChannelId: () => {},
    getMonitorCacheHealth: () => ({ healthy: true }),
    isTextMonitorEnabled: () => true,
    getMissingBotChannelPermissions: (_channel, _botMember, options) => {
      capturedOptions = options;
      return [];
    },
    postRaidChannelWelcome: async () => null,
    postChannelAnnouncement: async () => null,
    getAnnouncementsConfig: () => ({}),
    resolveRaidMonitorChannel: async () => null,
    cleanupRaidChannelMessages: async () => ({ ok: true }),
    getTargetCleanupSlotKey: () => "slot",
  });

  await command.handleRaidChannelCommand({
    guildId: "guild-1",
    user: { id: "admin-1" },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild },
    guild: { members: { me: { id: "bot" } } },
    options: {
      getString: () => "set-bg-channel",
      getChannel: () => channel,
    },
    reply: async () => {},
  });

  const labels = capturedOptions.requiredPerms.map((perm) => perm.label);
  assert.deepEqual(labels, [
    "View Channel",
    "Send Messages",
    "Attach Files",
    "Read Message History",
  ]);
  assert.equal(savedUpdate.raidBgChannelId, "bg-channel");
});

test("raid channel permission helper honors per-feature permission sets", () => {
  const service = createRaidChannelMonitorService({
    PermissionFlagsBits,
    EmbedBuilder,
    UI: {},
    GuildConfig: {},
    RAID_REQUIREMENT_MAP: {},
    getGatesForRaid: () => [],
    applyRaidSetForDiscordId: async () => null,
    getAnnouncementsConfig: () => ({}),
    normalizeName: (value) => String(value || "").toLowerCase(),
  });
  const allowed = new Set([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const channel = {
    permissionsFor: () => ({
      has: (flag) => allowed.has(flag),
    }),
  };

  const missing = service.getMissingBotChannelPermissions(channel, { id: "bot" }, {
    requiredPerms: [
      { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
      { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
      { flag: PermissionFlagsBits.AttachFiles, label: "Attach Files" },
      { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
    ],
  });

  assert.deepEqual(missing, ["Attach Files"]);
});

test("raid-bg set reports bg channel send failure without saving broken refs", async (t) => {
  const png = makePngBuffer();
  const originalFetch = global.fetch;
  const originalFindOne = GuildConfig.findOne;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(png),
  });
  GuildConfig.findOne = () => ({
    select: () => ({
      lean: async () => ({ raidBgChannelId: "bg-channel" }),
    }),
  });
  t.after(() => {
    global.fetch = originalFetch;
    GuildConfig.findOne = originalFindOne;
  });

  let persisted = false;
  const edits = [];
  const User = makeUserModel("en");
  User.findOneAndUpdate = async () => {
    persisted = true;
  };
  const command = createRaidBgCommand({
    User,
    saveWithRetry: async (op) => op(),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    client: {
      channels: {
        fetch: async () => ({
          id: "bg-channel",
          isTextBased: () => true,
          send: async () => {
            throw new Error("Missing Permissions");
          },
        }),
      },
    },
    options: {
      getSubcommand: () => "set",
      getAttachment: () => ({
        url: "https://cdn.example/background.png",
        name: "background.png",
        contentType: "image/png",
        size: png.length,
      }),
    },
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(persisted, false);
  assert.match(edits[0].embeds[0].data.description, /Missing Permissions/);
});

test("raid-bg set previews the rehosted attachment URL", async (t) => {
  const png = makePngBuffer();
  const originalFetch = global.fetch;
  const originalFindOne = GuildConfig.findOne;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(png),
  });
  GuildConfig.findOne = () => ({
    select: () => ({
      lean: async () => ({ raidBgChannelId: "bg-channel" }),
    }),
  });
  t.after(() => {
    global.fetch = originalFetch;
    GuildConfig.findOne = originalFindOne;
  });

  let savedUpdate = null;
  const edits = [];
  const User = makeUserModel("en");
  User.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
  };
  const command = createRaidBgCommand({
    User,
    saveWithRetry: async (op) => op(),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-2" },
    client: {
      channels: {
        fetch: async () => ({
          id: "bg-channel",
          isTextBased: () => true,
          send: async () => ({
            id: "message-1",
            attachments: {
              first: () => ({ url: "https://cdn.example/rehosted.png" }),
            },
          }),
        }),
      },
    },
    options: {
      getSubcommand: () => "set",
      getAttachment: () => ({
        url: "https://cdn.example/original.png",
        name: "background.png",
        contentType: "image/png",
        size: png.length,
      }),
    },
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(savedUpdate.$set.backgroundImageMessageId, "message-1");
  assert.equal(edits[0].embeds[0].data.image.url, "https://cdn.example/rehosted.png");
});
