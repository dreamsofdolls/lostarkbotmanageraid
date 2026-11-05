"use strict";

// B notices on /raid-check: each outcome names its own kind, a failure keeps
// the raw error in the detail field, and the sync report takes its kind from
// how the run went.

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

const { createRaidCheckAutoManageUi } = require("../bot/handlers/raid-check/auto-manage/auto-manage");
const { createRaidCheckCommand } = require("../bot/handlers/raid-check");
const { createSyncUi } = require("../bot/handlers/raid-check/views/sync-ui");
const { clearUserLanguageCache, t } = require("../bot/services/i18n");
const { UI } = require("../bot/utils/raid/common/shared");

// findOne serves both the language lookup and the transition's fallback read.
function userModel({ update, existing = null }) {
  return {
    findOneAndUpdate: update,
    findOne: () => ({
      lean: async () => existing,
      select: () => ({ lean: async () => existing }),
    }),
  };
}

function clickInteraction(userId) {
  const edits = [];
  const followUps = [];
  return {
    edits,
    followUps,
    user: { id: userId },
    client: { users: { fetch: async () => null } },
    deferReply: async () => {},
    deferUpdate: async () => {},
    editReply: async (payload) => { edits.push(payload); },
    followUp: async (payload) => { followUps.push(payload); },
  };
}

function autoUi(User) {
  return createRaidCheckAutoManageUi({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, User,
  });
}

for (const [label, existing, icon] of [
  ["local-sync on is a guard", { localSyncEnabled: true }, "🔒"],
  ["already on is input", { autoManageEnabled: true }, "✏️"],
]) {
  test(`raid-check self enable refusal: ${label}, not done`, async () => {
    clearUserLanguageCache();
    const interaction = clickInteraction("user-1");
    await autoUi(userModel({ update: async () => null, existing }))
      .handleRaidCheckEnableAutoSelfClick(interaction, "user-1");

    const card = interaction.edits.at(-1).embeds[0].toJSON();
    assert.ok(card.title.startsWith(`${icon}  `), card.title);
    assert.equal(card.color, UI.colors.progress);
    assert.ok(card.timestamp);
    assert.ok(card.footer?.text.startsWith("💡 "));
  });
}

test("raid-check manager enable failure keeps the error in the detail field only", async () => {
  clearUserLanguageCache();
  const interaction = clickInteraction("manager-1");
  await autoUi(userModel({ update: async () => { throw new Error("E11000 write conflict"); } }))
    .handleRaidCheckEnableAutoOneClick(interaction, "user-1");

  const card = interaction.edits.at(-1).embeds[0].toJSON();
  assert.ok(card.title.startsWith("❌  "), card.title);
  assert.equal(card.color, UI.colors.danger);
  assert.doesNotMatch(card.description, /E11000/);
  const detail = card.fields.find((field) => field.name === t("common.fields.details", "vi"));
  assert.ok(detail, "detail field");
  assert.match(detail.value, /E11000 write conflict/);
});

test("raid-check refuses a non-manager on a guard card that names who can use it", async () => {
  clearUserLanguageCache();
  const replies = [];
  const command = createRaidCheckCommand({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
    User: { findOne: () => ({ lean: async () => ({ language: "vi" }) }) },
    isRaidLeader: () => false,
    RAID_REQUIREMENT_MAP: {},
  });
  const surfaces = [
    (reply) => command.handleRaidCheckCommand({
      user: { id: "member" }, deferReply: async () => {}, editReply: reply,
    }),
    (reply) => command.handleRaidCheckButton({
      customId: "raid-check:sync-all", user: { id: "member" }, deferReply: async () => {}, editReply: reply,
    }),
  ];
  for (const run of surfaces) await run(async (payload) => { replies.push(payload); });

  assert.equal(replies.length, 2);
  for (const payload of replies) {
    const card = payload.embeds[0].toJSON();
    assert.ok(card.title.startsWith("🔒  "), card.title);
    assert.equal(card.color, UI.colors.progress);
    const who = card.fields.find((field) => field.name.startsWith("👥"));
    assert.ok(who, "who-can-use field");
    assert.match(who.value, /Raid Manager/);
  }
});

function syncUi(statuses) {
  const ids = Object.keys(statuses);
  const docs = ids.map((discordId) => ({
    discordId, autoManageEnabled: true,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
  }));
  return createSyncUi({
    EmbedBuilder, MessageFlags, UI,
    User: {
      find: () => ({ select() { return this; }, lean: async () => docs }),
      findOne: ({ discordId }) => discordId === "manager"
        ? { lean: async () => ({ language: "en" }) }
        : Promise.resolve(docs.find((doc) => doc.discordId === discordId)),
    },
    ensureFreshWeek: () => {}, weekResetStartMs: () => 1234,
    autoManageEntryKey: (account, char) => `${account}:${char}`,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    stampAutoManageAttempt: async () => {},
    gatherAutoManageLogsForUserDoc: async (doc) => {
      if (statuses[doc.discordId] === "throw") throw new Error("Gather failed");
      return [];
    },
    commitAutoManageCollected: async () => ({ status: "synced-no-delta", report: { perChar: [] } }),
    isPublicLogDisabledError: () => false,
    raidCheckSyncLimiter: { run: (fn) => fn() },
    discordUserLimiter: { run: (fn) => fn() },
  });
}

for (const [label, statuses, icon, color] of [
  ["a clean run is done", { a: "ok", b: "ok" }, "✅", UI.colors.success],
  ["a run with a failure is partial", { a: "ok", b: "throw" }, "⚠️", UI.colors.progress],
  ["a run where everyone failed is a failure", { a: "throw", b: "throw" }, "❌", UI.colors.danger],
]) {
  test(`raid-check sync report: ${label}, stamped, counters kept`, async () => {
    clearUserLanguageCache();
    let reply;
    await syncUi(statuses).handleRaidCheckSyncClick({
      user: { id: "manager" }, client: { users: {} },
      deferReply: async () => {}, editReply: async (payload) => { reply = payload; },
    });

    const card = reply.embeds[0].toJSON();
    assert.ok(card.title.startsWith(`${icon}  `), card.title);
    assert.equal(card.color, color);
    assert.ok(card.timestamp);
    assert.ok(card.footer?.text.startsWith("💡 "));
    const counters = card.fields.filter((field) => field.name !== "​").map((field) => field.name);
    assert.ok(counters.some((name) => name.includes(t("raid-check.syncFlow.reportFields.checked", "en"))));
    assert.ok(counters.some((name) => name.includes(t("raid-check.syncFlow.reportFields.synced", "en"))));
    assert.ok(counters.some((name) => name.includes(t("raid-check.syncFlow.reportFields.failed", "en"))));
  });
}
