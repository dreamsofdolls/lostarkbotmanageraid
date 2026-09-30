"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NEW_TAG,
  STALE_TAG,
  createEditRosterRenderers,
} = require("../bot/handlers/roster/edit/edit-render");

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
    ButtonStyle: {
      Danger: "danger",
      Primary: "primary",
      Secondary: "secondary",
      Success: "success",
    },
    UI: {
      colors: { muted: 1, neutral: 2, success: 3 },
      icons: { folder: "folder", info: "info", warn: "warn" },
    },
    pickerMaxOptions: 20,
    buttonsPerRow: 5,
  });
}

test("edit roster render marks new and stale chars in embed and buttons", () => {
  const { buildSelectionEmbed, buildSelectionComponents } = createRenderers();
  const session = {
    sessionId: "sess",
    lang: "en",
    accountName: "Alpha",
    bibleError: null,
    excludedBibleOnlyCount: 0,
    excludedSavedCount: 0,
    selectedIndices: new Set([0]),
    chars: [
      {
        charName: "SavedOnly",
        className: "Bard",
        itemLevel: 1700,
        combatScore: "85000",
        savedKey: "savedonly",
        inBible: false,
      },
      {
        charName: "BibleOnly",
        className: "Berserker",
        itemLevel: 1710,
        combatScore: "90000",
        savedKey: null,
        inBible: true,
      },
    ],
  };

  const embed = buildSelectionEmbed(session);
  assert.ok(embed.data.description.includes(STALE_TAG));
  assert.ok(embed.data.description.includes(NEW_TAG));

  const rows = buildSelectionComponents(session);
  assert.equal(rows[0].components[0].data.style, "success");
  assert.ok(rows[0].components[0].data.label.includes(STALE_TAG));
  assert.equal(rows[0].components[1].data.style, "secondary");
  assert.ok(rows[0].components[1].data.label.includes(NEW_TAG));
  assert.equal(rows.at(-1).components[0].data.disabled, false);
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
