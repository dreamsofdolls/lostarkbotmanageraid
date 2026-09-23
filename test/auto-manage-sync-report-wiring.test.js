"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const { createAutoManageSyncHandler } = require("../bot/handlers/raid/auto-manage/core/sync");
const { createAutoManageEnableHandler } = require("../bot/handlers/raid/auto-manage/core/enable");

const UI = { colors: { success: 1, danger: 2 }, icons: { done: "done", warn: "warn" } };

test("manual sync hands the saved user document to the report card", async () => {
  const doc = { discordId: "owner", accounts: [{ accountName: "Roster", characters: [] }], save: async () => {} };
  let received;
  const handleSync = createAutoManageSyncHandler({
    User: { findOne: async () => doc },
    saveWithRetry: (operation) => operation(),
    ensureFreshWeek: () => {},
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    formatAutoManageCooldownRemaining: () => "",
    getAutoManageCooldownMs: () => 600_000,
    weekResetStartMs: () => 1,
    gatherAutoManageLogsForUserDoc: async () => [],
    applyAutoManageCollected: () => ({ appliedTotal: 0, perChar: [] }),
    buildAutoManageSyncReportEmbed: (report, lang, options) => {
      received = { report, lang, options };
      return new EmbedBuilder().setDescription("report");
    },
  });

  await handleSync({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "en",
    replyAutoNotice: async () => assert.fail("no guard failure expected"),
    editAutoNotice: async () => assert.fail("no error expected"),
    editAutoEmbed: async () => {},
  });

  assert.equal(received.options.userDoc, doc);
  assert.equal(received.lang, "en");
});

function makeEnableHandler(commitAutoManageOn, captured) {
  return createAutoManageEnableHandler({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, UI,
    User: { findOne: async () => ({ accounts: [{ accountName: "Roster", characters: [] }] }) },
    ensureFreshWeek: () => {},
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    formatAutoManageCooldownRemaining: () => "",
    weekResetStartMs: () => 1,
    gatherAutoManageLogsForUserDoc: async () => [],
    applyAutoManageCollected: () => ({ appliedTotal: 0, perChar: [] }),
    isPublicLogDisabledError: () => false,
    commitAutoManageOn,
    buildAutoManageSyncReportEmbed: (report, lang, options) => {
      captured.options = options;
      return new EmbedBuilder().setDescription("report");
    },
    buildAutoManageHiddenCharsWarningEmbed: () => new EmbedBuilder().setDescription("hidden"),
    stampAutoManageAttempt: async () => {},
  });
}

test("action:on hands the committed user document to the report card", async () => {
  const saved = { discordId: "owner", accounts: [] };
  const captured = {};
  const handleOn = makeEnableHandler(async () => ({ report: { appliedTotal: 0, perChar: [] }, userDoc: saved }), captured);

  await handleOn({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "en",
    replyAutoNotice: async () => assert.fail("no guard failure expected"),
    editAutoNotice: async () => assert.fail("no error expected"),
    editAutoEmbed: async () => {},
  });

  assert.equal(captured.options.userDoc, saved);
  assert.equal(captured.options.titleText, require("../bot/services/i18n").t("raid-auto-manage.enable.initialSyncNothingTitle", "en"));
});

test("action:on reports an error when the user record disappears before commit", async (t) => {
  t.mock.method(console, "error", () => {});
  const captured = {};
  const notices = [];
  const handleOn = makeEnableHandler(async () => ({ report: undefined, userDoc: null }), captured);

  await handleOn({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "en",
    replyAutoNotice: async () => assert.fail("no guard failure expected"),
    editAutoNotice: async (notice) => { notices.push(notice); },
    editAutoEmbed: async () => {},
  });

  assert.equal(captured.options, undefined);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "error");
});
