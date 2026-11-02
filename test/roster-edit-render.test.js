"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { StringSelectMenuBuilder } = require("discord.js");

const { createEditRosterRenderers } = require("../bot/handlers/roster/edit/edit-render");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");

class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }

  setTimestamp() {
    this.data.timestamp = true;
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setLabel(label) {
    this.data.label = label;
    return this;
  }

  setStyle(style) {
    this.data.style = style;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }
}

function createRenderers() {
  return createEditRosterRenderers({
    EmbedBuilder: FakeEmbedBuilder,
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    StringSelectMenuBuilder,
    ButtonStyle: {
      Danger: "danger",
      Primary: "primary",
      Secondary: "secondary",
      Success: "success",
    },
    UI: {
      colors: { muted: 1, neutral: 2, success: 3, progress: 4 },
      icons: { folder: "folder", info: "info", warn: "warn" },
    },
    pickerMaxOptions: 20,
  });
}

function editChar(charName, className, extra = {}) {
  return {
    charName,
    className,
    itemLevel: 1700,
    combatScore: "3000",
    savedKey: charName.toLowerCase(),
    inBible: true,
    ...extra,
  };
}

function editSession(chars, selected, extra = {}) {
  return {
    sessionId: "sess",
    lang: "vi",
    accountName: "Alpha",
    bibleError: null,
    excludedBibleOnlyCount: 0,
    excludedSavedCount: 0,
    preservedSavedKeys: new Set(),
    preservedSavedClasses: [],
    selectedIndices: new Set(selected),
    expiresAt: 1_800_000_000_000,
    chars,
    ...extra,
  };
}

test("edit roster picker renders state glyphs, summary and close line", (t) => {
  CLASS_EMOJI_MAP.Paladin = "<:pal:1>";
  t.after(() => { CLASS_EMOJI_MAP.Paladin = ""; });
  const { buildSelectionEmbed } = createRenderers();
  const session = editSession([
    editChar("Alpha", "Paladin", { itemLevel: 1750, combatScore: "5000" }),
    editChar("Bardo", "Bard"),
    editChar("Berserka", "Berserker", { itemLevel: 1710, combatScore: "4000", savedKey: null }),
    editChar("Sorca", "Sorceress", { itemLevel: 1690, savedKey: null }),
  ], [0, 2]);

  const embed = buildSelectionEmbed(session).data;
  assert.equal(embed.title, "✏️ Sửa roster · <:pal:1> Alpha");
  assert.equal(embed.footer, undefined);
  assert.equal(embed.color, 4);
  const lines = embed.description.split("\n");
  assert.deepEqual(lines, [
    "Lưu xong còn **2** char · 🛡️ 1 · ⚔️ 1",
    "✅ **1.** <:pal:1> **Alpha** · `1750` · CP `5000`",
    "➖ **2.** Bard ~~Bardo~~ · `1700` · sẽ bỏ",
    "🆕 **3.** Berserker **Berserka** · `1710` · CP `4000` · mới trên Bible",
    "⬜ **4.** Sorceress Sorca · `1690` · CP `3000` · mới trên Bible",
    "",
    "⏳ Tớ giữ card tới <t:1800000000:t> nha, chưa **Lưu** là roster giữ nguyên.",
  ]);
});

test("edit roster picker hides the stale tag while Bible is down", () => {
  const { buildSelectionEmbed } = createRenderers();
  const chars = [
    editChar("Alpha", "Paladin", { inBible: false }),
    editChar("Bardo", "Bard", { inBible: false }),
  ];

  const down = buildSelectionEmbed(editSession(chars, [0, 1], { bibleError: "x" })).data.description;
  assert.doesNotMatch(down, /📦/);
  assert.match(down, /Chưa lấy được roster từ Bible: x\./);

  const reached = buildSelectionEmbed(editSession(chars, [0, 1])).data.description;
  assert.match(reached, / · 📦 không còn trên Bible$/m);
});

test("edit roster picker counts preserved characters beyond the cap", () => {
  const { buildSelectionEmbed, buildSelectionComponents } = createRenderers();
  const session = editSession([editChar("Bardo", "Bard"), editChar("Zerk", "Berserker")], [0, 1], {
    excludedSavedCount: 3,
    preservedSavedKeys: new Set(["p1", "p2", "p3"]),
    preservedSavedClasses: ["Paladin", "Artist", "Slayer"],
  });

  const description = buildSelectionEmbed(session).data.description;
  assert.equal(description.split("\n")[0], "Lưu xong còn **5** char · 🛡️ 3 · ⚔️ 2");
  assert.match(description, /\*\*3\*\* char đã lưu nằm ngoài giới hạn 20 của card/);
  assert.equal(buildSelectionComponents(session).at(-1).components[0].data.label, "Lưu (2)");
});

test("edit roster dropdown describes each state", () => {
  const { buildSelectionComponents } = createRenderers();
  const session = editSession([
    editChar("Alpha", "Paladin"),
    editChar("Bardo", "Bard"),
    editChar("Berserka", "Berserker", { savedKey: null }),
    editChar("Sorca", "Sorceress", { savedKey: null }),
  ], [0, 2]);

  const select = buildSelectionComponents(session)[0].components[0].toJSON();
  assert.equal(select.placeholder, "Chọn char để giữ/bỏ");
  assert.deepEqual(select.options.map((option) => option.description), [
    "✅ đang giữ · tick để bỏ",
    "➖ sẽ bỏ · tick để giữ lại",
    "🆕 sẽ thêm · tick để bỏ",
    "⬜ chưa thêm · tick để thêm",
  ]);
  assert.equal(select.options[2].label, "3. Berserka 🆕");
  assert.equal(select.options[0].label, "1. Alpha");
});

test("edit roster saved card marks new characters in place and strikes the removed ones", () => {
  const { buildSavedEmbed } = createRenderers();
  const finalChars = [
    { name: "Qiylyn", class: "Artist", itemLevel: 1758, combatScore: "4812" },
    { name: "Canamech", class: "Machinist", itemLevel: 1700, combatScore: "2488" },
  ];
  const embed = buildSavedEmbed({ lang: "en", accountName: "Alpha" }, {
    added: ["Canamech"],
    removed: [{ name: "Du", class: "Gunlancer", itemLevel: 1712.5, combatScore: "2954" }],
    kept: ["Qiylyn"],
    finalChars,
  });

  assert.match(embed.data.description, /🆕 added \*\*Canamech\*\* · ➖ removed \*\*Du\*\*$/);
  const [characters, removed] = embed.data.fields;
  assert.match(characters.value, /\*\*Canamech\*\* 🆕/);
  assert.doesNotMatch(characters.value, /\*\*Qiylyn\*\* 🆕/);
  assert.equal(removed.value, "Gunlancer ~~Du~~ · `1712.5`");

  const refreshed = buildSavedEmbed({ lang: "en", accountName: "Alpha" }, {
    added: [], removed: [], kept: ["Qiylyn", "Canamech"], finalChars,
  });
  assert.match(refreshed.data.description, /refreshed iLvl and CP/);
  assert.equal(refreshed.data.fields.length, 1);
});

test("edit roster render disables confirm when no chars are selected", () => {
  const { buildSelectionComponents } = createRenderers();
  const rows = buildSelectionComponents({
    sessionId: "sess",
    lang: "en",
    selectedIndices: new Set(),
    chars: [{ charName: "A", savedKey: "a", inBible: true }],
  });

  assert.equal(rows.at(-1).components[0].data.disabled, true);
});
