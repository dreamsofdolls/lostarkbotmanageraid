"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  buildAllModeRaidFilterRow,
  buildAllModeUserFilterRow,
} = require("../bot/handlers/raid-check/all-mode/all-mode-filters");

class FakeSelectMenuBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setPlaceholder(placeholder) {
    this.data.placeholder = placeholder;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }

  addOptions(options) {
    this.data.options = options;
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

function t(key, lang, vars = {}) {
  return `${key}:${vars.name || vars.label || ""}:${vars.n ?? ""}`;
}

test("all-mode user filter sorts users by current pending count and marks selection", () => {
  const row = buildAllModeUserFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    authorMeta: new Map([
      ["u1", { displayName: "Low" }],
      ["u2", { displayName: "High" }],
    ]),
    computePendingAggregate: ({ raidFilter, userFilter }) => {
      assert.equal(raidFilter, "kazeros:hard");
      assert.equal(userFilter, null);
      return {
        totalPending: 5,
        perUserPending: new Map([
          ["u1", { count: 1, supports: 0, dps: 1 }],
          ["u2", { count: 4, supports: 1, dps: 3 }],
        ]),
      };
    },
    disabled: false,
    filterRaidId: "kazeros:hard",
    filterUserId: "u2",
    lang: "en",
    t,
    truncateText: (value) => String(value).slice(0, 100),
    visibleUserIds: ["u1", "u2"],
  });

  const options = row.components[0].data.options;
  assert.equal(options[0].value, FILTER_ALL);
  assert.equal(options[1].value, "u2");
  assert.equal(options[1].default, true);
  assert.equal(options[2].value, "u1");
});

test("all-mode raid filter scopes counts by the selected user and marks selected raid", () => {
  const row = buildAllModeRaidFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    computePendingAggregate: ({ raidFilter, userFilter }) => {
      assert.equal(raidFilter, null);
      assert.equal(userFilter, "u1");
      return {
        totalPending: 3,
        // Inserted in reverse-canonical order on purpose: the dropdown must
        // re-order them into raid-progression order (Act 4 before Kazeros),
        // not keep insertion order or sort by pending count.
        perRaidPending: new Map([
          ["kazeros:hard", { key: "kazeros:hard", label: "Kazeros Hard", raidKey: "kazeros", modeKey: "hard", pending: 3, supports: 1, dps: 2 }],
          ["armoche:normal", { key: "armoche:normal", label: "Act 4 Normal", raidKey: "armoche", modeKey: "normal", pending: 0, supports: 0, dps: 0 }],
        ]),
      };
    },
    disabled: true,
    filterRaidId: "kazeros:hard",
    filterUserId: "u1",
    lang: "en",
    t,
    truncateText: (value) => String(value).slice(0, 100),
  });

  const menu = row.components[0].data;
  assert.equal(menu.customId, "raid-check-all-filter:raid");
  assert.equal(menu.disabled, true);
  assert.equal(menu.options[0].value, FILTER_ALL_RAIDS);
  // Canonical progression order: Act 4 (armoche) before Kazeros, regardless
  // of pending count or insertion order.
  assert.equal(menu.options[1].value, "armoche:normal");
  assert.equal(menu.options[2].value, "kazeros:hard");
  assert.equal(menu.options[2].default, true);
});
