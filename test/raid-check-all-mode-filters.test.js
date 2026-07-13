"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  FILTER_ALL_ROSTERS,
  FILTER_NO_ROSTERS,
  FILTER_STATUS,
  buildAllModeRaidFilterRow,
  buildAllModeRosterFilterRow,
  buildAllModeStatusFilterRow,
  buildAllModeUserFilterRow,
  filterAllModePageIndices,
  getAllModeRosterSelectionForPage,
  normalizeAllModeStatusFilter,
  raidMatchesStatusFilter,
  resolveAllModeLocalPage,
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
  return [
    key,
    vars.name || vars.label || "",
    vars.n ?? "",
    vars.pending ?? "",
    vars.success ?? "",
  ].join(":");
}

function page(discordId, accountName, raids) {
  return {
    userDoc: { discordId },
    account: {
      accountName,
      characters: [{ raids }],
    },
  };
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

test("all-mode status filter exposes All, Pending, and Success choices", () => {
  const row = buildAllModeStatusFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    disabled: false,
    filterStatus: FILTER_STATUS.pending,
    lang: "en",
    t,
  });

  const menu = row.components[0].data;
  assert.equal(menu.customId, "raid-check-all-filter:status");
  assert.deepEqual(
    menu.options.map((option) => [option.value, option.default]),
    [
      [FILTER_STATUS.all, false],
      [FILTER_STATUS.pending, true],
      [FILTER_STATUS.success, false],
    ]
  );
});

test("all-mode status semantics treat partial raids as Pending and full clears as Success", () => {
  const pendingRaid = { isCompleted: false, completedGateKeys: ["G1"] };
  const successRaid = { isCompleted: true, completedGateKeys: ["G1", "G2"] };

  assert.equal(raidMatchesStatusFilter(pendingRaid, FILTER_STATUS.all), true);
  assert.equal(raidMatchesStatusFilter(pendingRaid, FILTER_STATUS.pending), true);
  assert.equal(raidMatchesStatusFilter(pendingRaid, FILTER_STATUS.success), false);
  assert.equal(raidMatchesStatusFilter(successRaid, FILTER_STATUS.pending), false);
  assert.equal(raidMatchesStatusFilter(successRaid, FILTER_STATUS.success), true);
  assert.equal(normalizeAllModeStatusFilter("unexpected"), FILTER_STATUS.all);
});

test("all-mode roster filter uses folder icons, shows full state, and hides raid mismatches", () => {
  const pagesData = [
    page("u1", "Alpha", [
      { raidKey: "kazeros", modeKey: "hard", isCompleted: false },
      { raidKey: "kazeros", modeKey: "hard", isCompleted: true },
    ]),
    page("u1", "Beta", [
      { raidKey: "act4", modeKey: "hard", isCompleted: false },
    ]),
    page("u1", "Gamma", [
      { raidKey: "kazeros", modeKey: "hard", isCompleted: true },
    ]),
  ];
  const row = buildAllModeRosterFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    disabled: false,
    filterRaidId: "kazeros:hard",
    filterRosterIndex: 2,
    filterStatus: FILTER_STATUS.all,
    filterUserId: "u1",
    getStatusRaidsForCharacter: (character) => character.raids,
    lang: "en",
    pagesData,
    t,
    truncateText: (value) => String(value).slice(0, 100),
  });

  const menu = row.components[0].data;
  assert.equal(menu.customId, "raid-check-all-filter:roster");
  assert.equal(menu.disabled, false);
  assert.deepEqual(menu.options.map((option) => option.value), [
    FILTER_ALL_ROSTERS,
    "0",
    "2",
  ]);
  assert.equal(menu.options[0].emoji, "📂");
  assert.equal(menu.options[1].emoji, "📁");
  assert.match(menu.options[0].label, /:1:2$/);
  assert.match(menu.options[1].label, /Alpha.*:1:1$/);
  assert.equal(menu.options[2].default, true);
});

test("all-mode roster filter disables itself when no roster matches active status", () => {
  const row = buildAllModeRosterFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    disabled: false,
    filterRaidId: "kazeros:hard",
    filterRosterIndex: null,
    filterStatus: FILTER_STATUS.pending,
    filterUserId: "u1",
    getStatusRaidsForCharacter: (character) => character.raids,
    lang: "en",
    pagesData: [
      page("u1", "Done", [
        { raidKey: "kazeros", modeKey: "hard", isCompleted: true },
      ]),
    ],
    t,
    truncateText: (value) => String(value).slice(0, 100),
  });

  const menu = row.components[0].data;
  assert.equal(menu.disabled, true);
  assert.equal(menu.options.length, 1);
  assert.equal(menu.options[0].value, FILTER_NO_ROSTERS);
});

test("all-mode page filtering keeps eligible pages and clears an invalid roster selection", () => {
  const pagesData = [
    page("u1", "Pending", [
      { raidKey: "kazeros", modeKey: "hard", isCompleted: false },
    ]),
    page("u1", "Other raid", [
      { raidKey: "act4", modeKey: "hard", isCompleted: false },
    ]),
    page("u1", "Done", [
      { raidKey: "kazeros", modeKey: "hard", isCompleted: true },
    ]),
    page("u2", "Another user", [
      { raidKey: "kazeros", modeKey: "hard", isCompleted: false },
    ]),
  ];
  const result = filterAllModePageIndices({
    pagesData,
    filterUserId: "u1",
    filterRosterIndex: 2,
    filterRaidId: "kazeros:hard",
    filterStatus: FILTER_STATUS.pending,
    getStatusRaidsForCharacter: (character) => character.raids,
  });

  assert.deepEqual(result.filteredIndices, [0]);
  assert.equal(result.filterRosterIndex, null);

  const taskViewResult = filterAllModePageIndices({
    pagesData,
    filterUserId: "u1",
    filterRosterIndex: 2,
    filterRaidId: "kazeros:hard",
    filterStatus: FILTER_STATUS.pending,
    getStatusRaidsForCharacter: (character) => character.raids,
    applyRaidEligibility: false,
  });
  assert.deepEqual(taskViewResult.filteredIndices, [0, 1, 2]);
  assert.equal(taskViewResult.filterRosterIndex, 2);
  assert.equal(
    resolveAllModeLocalPage({
      filteredIndices: taskViewResult.filteredIndices,
      filterRosterIndex: taskViewResult.filterRosterIndex,
    }),
    2
  );
});

test("all-mode roster dropdown and pagination resolve each other's position", () => {
  const filteredIndices = [3, 7, 9];

  assert.equal(
    resolveAllModeLocalPage({ filteredIndices, filterRosterIndex: 7 }),
    1
  );
  assert.equal(
    resolveAllModeLocalPage({
      filteredIndices,
      currentLocalPage: 99,
      resetPage: false,
    }),
    2
  );
  assert.equal(
    getAllModeRosterSelectionForPage({
      filterUserId: "u1",
      filteredIndices,
      currentLocalPage: 1,
    }),
    7
  );
  assert.equal(
    getAllModeRosterSelectionForPage({
      filterUserId: null,
      filteredIndices,
      currentLocalPage: 1,
    }),
    null
  );
});
