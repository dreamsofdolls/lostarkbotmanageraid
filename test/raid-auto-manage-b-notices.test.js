"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");

const { UI, buildNoticeEmbed } = require("../bot/utils/raid/common/shared");
const { createAutoManageResetHandler } = require("../bot/handlers/raid/auto-manage/core/reset");
const { createAutoManageEnableHandler } = require("../bot/handlers/raid/auto-manage/core/enable");
const { createAutoManageSyncHandler } = require("../bot/handlers/raid/auto-manage/core/sync");
const { createAutoManageBasicActionHandlers } = require("../bot/handlers/raid/auto-manage/basic-actions");
const {
  buildAutoManageStateNotice,
  getAutoManageStateGate,
} = require("../bot/handlers/raid/auto-manage/action-policy");

const render = (options) => buildNoticeEmbed(EmbedBuilder, options).toJSON();

test("auto-manage reset prompt is a confirm card that keeps its danger button", async () => {
  let prompt = null;
  const handler = createAutoManageResetHandler({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, UI,
  });
  await handler({
    discordId: "owner",
    lang: "vi",
    interaction: {
      fetchReply: async () => ({
        async awaitMessageComponent() { throw new Error("Collector expired"); },
      }),
    },
    replyAutoEmbed: async (embed, extras) => { prompt = { embed: embed.toJSON(), extras }; },
    editAutoEmbed: async () => {},
  });

  assert.ok(prompt.embed.title.startsWith("❔  "));
  assert.equal(prompt.embed.color, UI.colors.progress);
  assert.ok(prompt.embed.timestamp);
  const [confirmButton] = prompt.extras.components[0].toJSON().components;
  assert.equal(confirmButton.style, ButtonStyle.Danger);
});

test("auto-manage enable skipped by the cooldown is a partial card with the time left in a field", async () => {
  let card = null;
  const handler = createAutoManageEnableHandler({
    EmbedBuilder, UI,
    User: { findOneAndUpdate: async () => ({ autoManageEnabled: true }) },
    acquireAutoManageSyncSlot: async () => ({ acquired: false, reason: "cooldown", remainingMs: 60_000, release: () => {} }),
    formatAutoManageCooldownRemaining: () => "1 phút",
  });
  await handler({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "vi",
    editAutoEmbed: async (embed) => { card = embed.toJSON(); },
  });

  assert.ok(card.title.startsWith("⚠️  "));
  assert.equal(card.color, UI.colors.progress);
  assert.deepEqual(card.fields.map((field) => [field.name, field.value]), [["⏱️ Còn lại", "1 phút"]]);
  assert.ok(card.footer.text.startsWith("💡 "));
});

test("auto-manage off is a done card stamped by the notice helper", async () => {
  let card = null;
  const handlers = createAutoManageBasicActionHandlers({
    EmbedBuilder, UI,
    User: { findOneAndUpdate: async () => ({ autoManageEnabled: false }) },
  });
  await handlers.off({
    discordId: "owner",
    lang: "vi",
    replyAutoEmbed: async (embed) => { card = embed.toJSON(); },
  });

  assert.ok(card.title.startsWith("✅  "));
  assert.equal(card.color, UI.colors.success);
  assert.ok(card.timestamp);
  assert.doesNotMatch(card.title, /🔄/u);
});

test("auto-manage enable failure shows the error only in the detail field", async () => {
  let notice = null;
  const handler = createAutoManageEnableHandler({
    EmbedBuilder, UI,
    User: { findOne: async () => { throw new Error("bible probe down"); } },
    acquireAutoManageSyncSlot: async () => ({ acquired: true, release: () => {} }),
    weekResetStartMs: () => 123,
    stampAutoManageAttempt: async () => {},
  });
  await handler({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "vi",
    editAutoNotice: async (options) => { notice = options; },
  });

  const card = render(notice);
  assert.ok(card.title.startsWith("❌  "));
  assert.doesNotMatch(card.description, /bible probe down/);
  const detail = card.fields.find((field) => field.name === "🧾 Chi tiết");
  assert.match(detail.value, /bible probe down/);
});

test("auto-manage sync blocked by local-sync uses the same notice as the action gate", async () => {
  let notice = null;
  const handler = createAutoManageSyncHandler({
    User: { findOne: async () => ({ localSyncEnabled: true, accounts: [{}] }) },
    acquireAutoManageSyncSlot: async () => ({ acquired: true, release: () => {} }),
    weekResetStartMs: () => 123,
  });
  await handler({
    interaction: { deferReply: async () => {} },
    discordId: "owner",
    lang: "vi",
    editAutoNotice: async (options) => { notice = options; },
  });

  const gate = getAutoManageStateGate("sync", { localOn: true });
  assert.deepEqual(notice, buildAutoManageStateNotice(gate.notice, "vi"));
  assert.equal(notice.kind, "guard");
  assert.ok(notice.tip);
});
