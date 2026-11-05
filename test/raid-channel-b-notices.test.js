"use strict";

// B notices on /raid-channel, /raid-announce and /raid-language: refusals are
// guard, a missing option is input, results are done or partial on the
// notice helper, and a cleanup failure keeps its error in the detail field.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");

const { createRaidChannelCoreActions } = require("../bot/handlers/raid/channel/core-actions");
const { createRaidChannelCommand } = require("../bot/handlers/raid/channel");
const { createRaidAnnounceCommand } = require("../bot/handlers/raid/announce");
const { createRaidLanguageCommand } = require("../bot/handlers/meta/language");
const { buildNoticeEmbed, UI } = require("../bot/utils/raid/common/shared");
const { clearUserLanguageCache, t, tPick } = require("../bot/services/i18n");

const icon = (kind) => buildNoticeEmbed(EmbedBuilder, { kind, title: "x" }).toJSON().title.slice(0, -1);
// A collected reply is either notice options or a built embed.
const render = (entry) => (entry?.toJSON ? entry.toJSON() : buildNoticeEmbed(EmbedBuilder, entry).toJSON());

function coreActions(overrides = {}) {
  return createRaidChannelCoreActions({
    EmbedBuilder, UI,
    GuildConfig: {
      findOneAndUpdate: async () => {},
      findOne: () => ({ select() { return this; }, lean: async () => ({}) }),
    },
    getCachedMonitorChannelId: () => "chan1",
    setCachedMonitorChannelId: () => {},
    getMonitorCacheHealth: () => ({ healthy: true }),
    isTextMonitorEnabled: () => true,
    getMissingBotChannelPermissions: () => [],
    postRaidChannelWelcome: async () => ({ posted: true, pinned: true, removedOldCount: 1 }),
    postChannelAnnouncement: async () => {},
    getAnnouncementsConfig: () => ({ setGreeting: { enabled: false } }),
    resolveRaidMonitorChannel: async () => ({ id: "chan1" }),
    cleanupAndRefreshRaidChannel: async () => ({ deleted: 12, skippedOld: 3 }),
    getGuildLanguage: async () => "vi",
    SUPPORTED_LANGUAGES: [{ code: "vi", flag: "🇻🇳", label: "Tiếng Việt" }],
    t: tPick,
    ...overrides,
  });
}

function collector() {
  const out = [];
  const push = (entry) => { out.push(entry); };
  return {
    out,
    ctx: {
      guildId: "guild1", lang: "vi",
      interaction: {
        options: { getChannel: () => null },
        client: { user: { id: "bot" } },
        guild: { members: { me: {} } },
        deferReply: async () => {}, deferred: false, replied: false,
      },
      replyChannelNotice: push, replyChannelEmbed: push,
      editChannelNotice: push, editChannelEmbed: push,
    },
  };
}

test("raid-channel set without a channel is input, with a title free of backticks", async () => {
  const { out, ctx } = collector();
  await coreActions().handleSetChannel(ctx);
  const card = render(out[0]);
  assert.ok(card.title.startsWith(icon("input")), card.title);
  assert.doesNotMatch(card.title, /`/);
  assert.ok(card.footer?.text.startsWith("💡 "));
});

test("raid-channel cleanup and repin results are done cards with at most three fields", async () => {
  for (const run of [(a, ctx) => a.handleCleanupChannel(ctx), (a, ctx) => a.handleRepinChannel(ctx)]) {
    const { out, ctx } = collector();
    await run(coreActions(), ctx);
    const card = render(out.at(-1));
    assert.ok(card.title.startsWith(icon("done")), card.title);
    assert.ok(card.fields.length <= 3, `${card.fields.length} fields`);
    assert.ok(card.timestamp);
  }
});

test("raid-channel repin whose pin failed is partial", async () => {
  const { out, ctx } = collector();
  await coreActions({
    postRaidChannelWelcome: async () => ({ posted: true, pinned: false, removedOldCount: 0 }),
  }).handleRepinChannel(ctx);
  assert.ok(render(out.at(-1)).title.startsWith(icon("partial")));
});

test("raid-channel cleanup failure keeps the error in the detail field only", async (t2) => {
  t2.mock.method(console, "error", () => {});
  const { out, ctx } = collector();
  await coreActions({
    cleanupAndRefreshRaidChannel: async () => { throw new Error("Missing Access 50001"); },
  }).handleCleanupChannel(ctx);
  const card = render(out.at(-1));
  assert.ok(card.title.startsWith(icon("failure")), card.title);
  assert.doesNotMatch(card.description, /50001/);
  const detail = card.fields.find((field) => field.name === t("common.fields.details", "vi"));
  assert.match(detail?.value || "", /Missing Access 50001/);
});

test("server-only and Manage Server refusals are guard on /raid-channel and /raid-announce", async () => {
  clearUserLanguageCache();
  const User = { findOne: () => ({ lean: async () => ({ language: "vi" }) }) };
  const channel = createRaidChannelCommand({ EmbedBuilder, PermissionFlagsBits, UI, User, GuildConfig: {} });
  const announce = createRaidAnnounceCommand({
    EmbedBuilder, PermissionFlagsBits, UI, User, GuildConfig: {},
    announcementTypeEntry: () => null, getAnnouncementsConfig: () => ({}),
  });
  const cases = [
    [channel.handleRaidChannelCommand, { guildId: null }],
    [channel.handleRaidChannelCommand, { guildId: "g", memberPermissions: { has: () => false } }],
    [announce.handleRaidAnnounceCommand, { guildId: null }],
    [announce.handleRaidAnnounceCommand, { guildId: "g", memberPermissions: { has: () => false } }],
  ];
  for (const [handle, fields] of cases) {
    const replies = [];
    await handle({ user: { id: "member" }, reply: async (payload) => { replies.push(payload); }, ...fields });
    const card = replies[0].embeds[0].toJSON();
    assert.ok(card.title.startsWith(icon("guard")), card.title);
    assert.equal(card.color, UI.colors.progress);
  }
});

test("a language change is a done card without the 🌐 glyph in its title", async () => {
  clearUserLanguageCache();
  const { handleRaidLanguageSelect } = createRaidLanguageCommand({
    EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags: { Ephemeral: 64 }, UI,
  });
  const User = require("../bot/models/user");
  const original = { findOne: User.findOne, findOneAndUpdate: User.findOneAndUpdate, updateOne: User.updateOne };
  User.findOne = () => ({ lean: async () => ({ language: "vi" }), select() { return this; } });
  User.findOneAndUpdate = async () => ({ language: "en" });
  User.updateOne = async () => ({ acknowledged: true });
  try {
    let update;
    await handleRaidLanguageSelect({
      user: { id: "lang-user" }, values: ["en"],
      update: async (payload) => { update = payload; },
    });
    const card = update.embeds[0].toJSON();
    assert.ok(card.title.startsWith(icon("done")), card.title);
    assert.doesNotMatch(card.title, /🌐/);
    assert.ok(card.timestamp);
  } finally {
    Object.assign(User, original);
  }
});
