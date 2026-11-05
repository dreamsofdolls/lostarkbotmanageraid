"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

const { NoticeKind, buildNoticeEmbed } = require("../bot/utils/raid/common/shared");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");
const { buildAddSingleNotice } = require("../bot/handlers/raid/task/add/add-single");
const { createAddAllHandler } = require("../bot/handlers/raid/task/add/add-all");
const { buildClearPreviewNotice } = require("../bot/handlers/raid/task/clear/preview");
const { buildClearConfirmRow } = require("../bot/handlers/raid/task/clear/components");
const { buildSaveFailedNotice } = require("../bot/handlers/raid/task/write-handler");
const { buildShareRefusalNotice } = require("../bot/handlers/raid/task/notices");

const render = (options) => buildNoticeEmbed(EmbedBuilder, options).toJSON();

test("raid-task add success is a done card with the class icon", () => {
  const saved = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = "<:bard:9>";
  try {
    const options = buildAddSingleNotice(
      { outcome: "added", resolvedCharName: "Crimsonjudgment", resolvedCharClass: "Bard", dailyCount: 1, weeklyCount: 0 },
      { taskName: "Chaos Dungeon", reset: "daily" },
      "vi",
    );
    assert.equal(options.kind, NoticeKind.DONE);
    const embed = render(options);
    assert.equal(embed.title, "✅  Đã thêm side task");
    assert.equal(typeof options.description, "string");
    assert.match(embed.description, /<:bard:9> \*\*Crimsonjudgment\*\*/u);
    assert.match(embed.description, /Chaos Dungeon/u);
    assert.deepEqual(embed.fields.map((f) => f.name), ["🔁 Chu kỳ", "🎟️ Slot còn"]);
    assert.ok(embed.footer.text.startsWith("💡 "));
    assert.ok(embed.timestamp);
  } finally {
    CLASS_EMOJI_MAP.Bard = saved;
  }
});

test("raid-task add all lists added and skipped characters with their class icon", async () => {
  const saved = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = "<:bard:9>";
  try {
    const notices = [];
    const doc = {
      accounts: [{
        accountName: "Vencone",
        characters: [
          { name: "Crimsonjudgment", class: "Bard", sideTasks: [] },
          { name: "Fullslot", class: "Bard", sideTasks: [{ taskId: "t1", name: "Chaos Dungeon", reset: "daily" }] },
        ],
      }],
      async save() {},
    };
    const handler = createAddAllHandler({
      User: {
        findOne: (_query, projection) => (projection
          ? { lean: async () => ({ language: "vi" }) }
          : Promise.resolve(doc)),
      },
      saveWithRetry: async (fn) => fn(),
      dailyResetStartMs: () => 1,
      weekResetStartMs: () => 2,
      resolveTaskWriteTarget: async (id) => ({ discordId: id, viaShare: false, canEdit: true }),
      replyTaskNotice: async (_interaction, notice) => notices.push(notice),
      replyViewOnlyShareNotice: async () => {},
      replyShareRefusalNotice: async () => {},
    });
    await handler({
      user: { id: "add-all-class-icon" },
      options: { getString: (key) => ({ roster: "Vencone", name: "Chaos Dungeon", reset: "daily" })[key] },
    });

    assert.equal(notices.length, 1);
    const embed = render(notices[0]);
    assert.ok(embed.title.startsWith("✅  "));
    const added = embed.fields.find((field) => field.name === "✅ Đã thêm");
    assert.match(added.value, /^1\/2\n<:bard:9> \*\*Crimsonjudgment\*\*$/u);
    const skipped = embed.fields.find((field) => field.name === "⏭️ Bỏ qua");
    assert.match(skipped.value, /<:bard:9> \*\*Fullslot\*\*: đã có task này/u);
  } finally {
    CLASS_EMOJI_MAP.Bard = saved;
  }
});

test("raid-task save failure is a failure card without developer words", () => {
  const options = buildSaveFailedNotice("raid-task.save.addFailedDescription", "vi");
  assert.equal(options.kind, NoticeKind.FAILURE);
  const embed = render(options);
  assert.ok(embed.title.startsWith("❌  "));
  assert.doesNotMatch(`${embed.title} ${embed.description}`, /Mongo|ops|fail/iu);
  assert.equal(embed.fields, undefined);
  assert.ok(embed.footer.text.startsWith("💡 "));
});

test("raid-task clear prompt is a confirm card with a danger button", () => {
  const found = {
    character: { name: "Crimsonjudgment", class: "Bard", sideTasks: [{ reset: "daily" }, { reset: "weekly" }] },
  };
  const options = buildClearPreviewNotice(found, "Crimsonjudgment", "vi");
  assert.equal(options.kind, NoticeKind.CONFIRM);
  assert.ok(render(options).title.startsWith("❔  "));
  const row = buildClearConfirmRow({
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    resolvedRosterName: "Vencone", resolvedCharName: "Crimsonjudgment", lang: "vi",
  }).toJSON();
  assert.equal(row.components[0].style, ButtonStyle.Danger);
});

test("a view-only share is a guard card", () => {
  const options = buildShareRefusalNotice("viewOnly", { ownerLabel: "Bao" }, "vi");
  assert.equal(options.kind, NoticeKind.GUARD);
  const embed = render(options);
  assert.ok(embed.title.startsWith("🔒  "));
  assert.doesNotMatch(embed.title, /`/u);
});

test("no roster and roster not found use the shared empty copy", () => {
  const noRoster = buildAddSingleNotice({ outcome: "no-roster" }, {}, "vi");
  assert.equal(noRoster.kind, NoticeKind.EMPTY);
  assert.equal(render(noRoster).title, "🔍  Cậu chưa có roster nào");
});
