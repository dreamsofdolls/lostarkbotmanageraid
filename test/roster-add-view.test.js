"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  buildSeedRosterLink,
  createAddRosterViewBuilders,
} = require("../bot/handlers/roster/add/view");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");

const UI = {
  colors: { muted: 1, neutral: 2, success: 3 },
  icons: { info: "[info]", roster: "[roster]", warn: "[warn]" },
};

function makeBuilders() {
  const calls = [];
  return {
    calls,
    builders: createAddRosterViewBuilders({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      UI,
      t(key, lang, vars = {}) {
        calls.push({ key, lang, vars });
        return `${key}:${lang}`;
      },
    }),
  };
}

test("raid-add roster view builds bible roster links with encoded seed names", () => {
  assert.equal(
    buildSeedRosterLink("Qi ylyn+"),
    "https://lostark.bible/character/NA/Qi%20ylyn%2B/roster"
  );
});

function makeLocaleBuilders() {
  const { t } = require("../bot/services/i18n");
  return createAddRosterViewBuilders({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UI,
    t,
  });
}

function pickerSession(overrides = {}) {
  return {
    sessionId: "sess",
    lang: "vi",
    seedCharName: "Qiylyn",
    chars: [
      { charName: "Qiylyn", className: "Artist", itemLevel: 1700, combatScore: "100000" },
      { charName: "Bardly", className: "Bard", itemLevel: 1690, combatScore: "" },
    ],
    selectedIndices: new Set([0]),
    actingForOther: false,
    expiresAt: 1_800_000_000_000,
    ...overrides,
  };
}

test("raid-add roster picker renders the C+ card and the flip dropdown", (t) => {
  // The bootstrap fills class icons at runtime; Bard stays without one.
  CLASS_EMOJI_MAP.Artist = "<:artist:123>";
  t.after(() => { CLASS_EMOJI_MAP.Artist = ""; });
  const builders = makeLocaleBuilders();
  const session = pickerSession();

  const embed = builders.buildSelectionEmbed(session).toJSON();
  assert.equal(embed.title, "📥 Thêm roster · <:artist:123> Qiylyn");
  assert.equal(embed.url, buildSeedRosterLink("Qiylyn"));
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
  const lines = embed.description.split("\n");
  assert.equal(lines[0], "Chọn **1** / 2 char · 🛡️ 1 · ⚔️ 0");
  assert.equal(lines[1], "✅ **1.** <:artist:123> **Qiylyn** · `1700` · CP `100000`");
  assert.equal(lines[2], "⬜ **2.** Bard Bardly · `1690` · CP `?`");
  assert.equal(lines[3], "");
  assert.equal(lines.at(-1), "⏳ Tớ giữ card tới <t:1800000000:t> nha, chưa **Lưu** là tớ chưa thêm gì đâu.");

  const rows = builders.buildSelectionComponents(session).map((row) => row.toJSON());
  assert.equal(rows.length, 2);
  const select = rows[0].components[0];
  assert.equal(select.placeholder, "Chọn char để theo dõi/bỏ qua");
  assert.equal(select.options[0].label, "1. Qiylyn");
  assert.equal(select.options[0].description, "✅ đang chọn · tick để bỏ");
  assert.equal(select.options[0].emoji.id, "123");
  assert.equal(select.options[1].description, "⬜ bỏ qua · tick để chọn");
  assert.equal(select.options[1].emoji, undefined);
  assert.equal(rows[1].components[0].label, "Lưu (1)");
  assert.equal(rows[1].components[0].disabled, false);
});

test("raid-add roster picker shows the manager line above the close line", () => {
  const builders = makeLocaleBuilders();
  const session = pickerSession({ actingForOther: true, callerId: "manager-1", targetId: "target-1" });

  const lines = builders.buildSelectionEmbed(session).toJSON().description.split("\n");
  assert.equal(lines.at(-2), "[info] Raid Manager <@manager-1> đang add giúp <@target-1>.");
  assert.match(lines.at(-1), /^⏳ /);
});

test("raid-add roster saved embed reports target DM failure for manager flow", () => {
  const { builders, calls } = makeBuilders();
  const session = {
    lang: "vi",
    seedCharName: "Qiylyn",
    actingForOther: true,
    callerId: "manager-1",
    targetId: "target-1",
  };
  const savedAccount = {
    accountName: "Qiylyn",
    characters: [{ name: "Qiylyn", class: "Artist", itemLevel: 1700, combatScore: "100000" }],
  };

  builders.buildSavedEmbed(session, savedAccount, { reason: "dms-disabled" }).toJSON();

  assert.ok(calls.some((call) => call.key === "raid-add-roster.saved.dmDisabled"));
});

function savedCharacter(name, className) {
  return { name, class: className, itemLevel: 1700, combatScore: "4000" };
}

test("raid-add roster saved card splits a 20-character roster and drops the source footer", (t) => {
  CLASS_EMOJI_MAP.Artist = "<:yinyangshi_a3f9b2:1234567890123456789>";
  t.after(() => { CLASS_EMOJI_MAP.Artist = ""; });
  const builders = makeLocaleBuilders();
  const characters = Array.from({ length: 20 }, (_, index) => savedCharacter(`Characterno${index}`, "Artist"));
  const embed = builders.buildSavedEmbed(
    pickerSession({ seedCharName: "Characterno0" }),
    { accountName: "Characterno0", characters },
  ).toJSON();

  assert.ok(embed.title.startsWith("📥 Đã lưu roster · <:yinyangshi_a3f9b2:1234567890123456789> Characterno0"));
  assert.equal(embed.url, buildSeedRosterLink("Characterno0"));
  assert.equal(embed.description.split("\n")[0], "Artist theo dõi **20** char · 🛡️ 20 · ⚔️ 0");
  assert.ok(embed.fields.length >= 2);
  for (const field of embed.fields) assert.ok(field.value.length <= 1024);
  assert.equal(embed.fields[1].name, "\u200b");
  assert.equal(embed.fields.flatMap((field) => field.value.split("\n")).length, 20);
  assert.equal(embed.footer.text, "Sửa sau bằng /raid-edit-roster");
  assert.equal(embed.timestamp, undefined);
});

test("raid-add roster closed cards carry the roster icon and no footer", () => {
  const builders = makeLocaleBuilders();
  const session = pickerSession({
    seedCharName: "Spindazz",
    chars: [{ charName: "Spindazz", className: "Slayer", itemLevel: 1700, combatScore: "1" }],
  });

  const expired = builders.buildExpiredEmbed(session).toJSON();
  assert.equal(expired.title, "⏳ Hết giờ · ❓ Spindazz");
  assert.equal(expired.url, buildSeedRosterLink("Spindazz"));
  assert.equal(expired.footer, undefined);
  const cancelled = builders.buildCancelledEmbed(session).toJSON();
  assert.equal(cancelled.title, "✖️ Đã huỷ · ❓ Spindazz");
  assert.equal(cancelled.footer, undefined);
});

test("raid-add target DM lists commands in a field and drops the footer", () => {
  const builders = makeLocaleBuilders();
  const embed = builders.buildTargetDMEmbed(
    pickerSession({ callerId: "manager-1" }),
    { accountName: "Qiylyn", characters: [savedCharacter("Qiylyn", "Bard")] },
    "Guild",
    "vi",
  ).toJSON();

  assert.equal(embed.title, "📥 Roster mới cho cậu · ❓ Qiylyn");
  assert.match(embed.description, /Tớ đang theo dõi \*\*1\*\* char · 🛡️ 1 · ⚔️ 0/);
  assert.ok(embed.fields.some((field) => field.name === "Lệnh hay dùng"));
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
});
