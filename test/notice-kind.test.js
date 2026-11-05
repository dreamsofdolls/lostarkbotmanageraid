"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");

const {
  NoticeKind,
  UI,
  buildNoticeEmbed,
  buildDetailField,
  formatCharacterLabel,
} = require("../bot/utils/raid/common/shared");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");

// One icon and one colour per kind; the spec's kind table, verbatim.
const KIND_LOOK = {
  guard: ["🔒", UI.colors.progress],
  expired: ["⌛", UI.colors.muted],
  input: ["✏️", UI.colors.progress],
  empty: ["🔍", UI.colors.neutral],
  busy: ["🚦", UI.colors.progress],
  failure: ["❌", UI.colors.danger],
  progress: ["⏳", UI.colors.neutral],
  done: ["✅", UI.colors.success],
  partial: ["⚠️", UI.colors.progress],
  confirm: ["❔", UI.colors.progress],
};

test("each kind gives its icon and colour", () => {
  assert.deepEqual(Object.values(NoticeKind).sort(), Object.keys(KIND_LOOK).sort());
  for (const [kind, [icon, color]] of Object.entries(KIND_LOOK)) {
    const embed = buildNoticeEmbed(EmbedBuilder, { kind, title: "T" }).toJSON();
    assert.equal(embed.title, `${icon}  T`, kind);
    assert.equal(embed.color, color, kind);
  }
});

test("a kind notice has a timestamp", () => {
  const embed = buildNoticeEmbed(EmbedBuilder, { kind: NoticeKind.DONE, title: "T" }).toJSON();
  assert.ok(embed.timestamp);
});

test("a tip renders plain", () => {
  const embed = buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.EMPTY,
    title: "T",
    tip: "Gõ `/raid-status` **ngay**",
  }).toJSON();
  assert.equal(embed.footer.text, "💡 Gõ /raid-status ngay");
});

test("over-long parts are clamped", () => {
  const embed = buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.FAILURE,
    title: "t".repeat(300),
    fields: [{ name: "n", value: "v".repeat(2000) }],
    tip: "p".repeat(3000),
  }).toJSON();
  assert.equal(embed.title.length, 256);
  assert.equal(embed.fields[0].value.length, 1024);
  assert.equal(embed.footer.text.length, 2048);
});

test("fields with no value are dropped", () => {
  const embed = buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.DONE,
    title: "T",
    fields: [null, { name: "a", value: "" }, { name: "b", value: "1", inline: true }],
  }).toJSON();
  assert.deepEqual(embed.fields, [{ name: "b", value: "1", inline: true }]);
});

test("formatCharacterLabel shows the class icon when known", () => {
  const saved = CLASS_EMOJI_MAP.Berserker;
  CLASS_EMOJI_MAP.Berserker = "<:x:1>";
  try {
    assert.equal(formatCharacterLabel("Name", "Berserker"), "<:x:1> **Name**");
  } finally {
    CLASS_EMOJI_MAP.Berserker = saved;
  }
  assert.equal(formatCharacterLabel("Name", "NoSuchClass"), "**Name**");
  assert.equal(formatCharacterLabel("Name", undefined), "**Name**");
});

test("buildDetailField wraps the error in code font and skips empty", () => {
  assert.deepEqual(buildDetailField("boom", "vi"), { name: "🧾 Chi tiết", value: "`boom`", inline: false });
  assert.deepEqual(buildDetailField("boom", "en").name, "🧾 Details");
  assert.deepEqual(buildDetailField("boom", "jp").name, "🧾 詳細");
  assert.equal(buildDetailField("", "vi"), null);
  assert.equal(buildDetailField(undefined, "vi"), null);
  assert.equal(buildDetailField("x".repeat(2000), "vi").value.length, 1024);
});

test("legacy type still renders as before", () => {
  const embed = buildNoticeEmbed(EmbedBuilder, { type: "warn", title: "T" }).toJSON();
  assert.equal(embed.title, `${UI.icons.warn} T`);
  assert.equal(embed.color, UI.colors.progress);
});
