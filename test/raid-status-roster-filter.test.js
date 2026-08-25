"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FILTER_ALL_ROSTERS,
  buildStatusRosterFilterEntries,
  buildStatusRosterFilterRow,
} = require("../bot/handlers/raid-status/raid-filter");
const {
  createRaidStatusComponentLayout,
} = require("../bot/handlers/raid-status/components/component-layout");
const {
  createRaidStatusRenderPayload,
} = require("../bot/handlers/raid-status/view/render-payload");
const { t } = require("../bot/services/i18n");

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

function account(accountName, raids) {
  return {
    accountName,
    characters: [{ raids }],
  };
}

test("raid-status roster entries separate display eligibility from progress counts", () => {
  const accounts = [
    account("Alpha", [
      { raidKey: "armoche", modeKey: "hard", isCompleted: false },
      {
        raidKey: "armoche",
        modeKey: "solo",
        isCompleted: true,
        goldReceives: true,
      },
      {
        raidKey: "kazeros",
        modeKey: "solo",
        isCompleted: false,
        goldReceives: true,
      },
    ]),
    account("Beta", [
      { raidKey: "kazeros", modeKey: "normal", isCompleted: true },
    ]),
  ];
  const getRaidsFor = (character) => character.raids;

  assert.deepEqual(
    buildStatusRosterFilterEntries({ accounts, getRaidsFor }).map(
      ({ pageIndex, pending, success, soloPending }) => ({
        pageIndex,
        pending,
        success,
        soloPending,
      })
    ),
    [
      { pageIndex: 0, pending: 1, success: 0, soloPending: 1 },
      { pageIndex: 1, pending: 0, success: 1, soloPending: 0 },
    ]
  );
  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "armoche:hard",
      getRaidsFor,
    }).map(({ pageIndex, pending, success, soloPending }) => ({
      pageIndex,
      pending,
      success,
      soloPending,
    })),
    [{ pageIndex: 0, pending: 1, success: 0, soloPending: 0 }]
  );
  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "armoche:solo",
      getRaidsFor,
    }).map(({ pageIndex, pending, success, soloPending, displayMatches }) => ({
      pageIndex,
      pending,
      success,
      soloPending,
      displayMatches,
    })),
    [{ pageIndex: 0, pending: 0, success: 0, soloPending: 0, displayMatches: 1 }]
  );
  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "kazeros:solo",
      getRaidsFor,
    }).map(({ pageIndex, pending, soloPending, displayMatches }) => ({
      pageIndex,
      pending,
      soloPending,
      displayMatches,
    })),
    [{ pageIndex: 0, pending: 0, soloPending: 1, displayMatches: 1 }]
  );
});

test("raid-status selected raid filter excludes gold-locked raids from roster and character display", () => {
  const openRaid = {
    raidKey: "kazeros",
    modeKey: "hard",
    isCompleted: false,
    goldReceives: true,
  };
  const lockedRaid = {
    raidKey: "kazeros",
    modeKey: "hard",
    isCompleted: false,
    goldReceives: false,
  };
  const accounts = [
    account("Open", [openRaid]),
    account("Locked", [lockedRaid]),
  ];
  const getRaidsFor = (character) => character.raids;

  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "kazeros:hard",
      getRaidsFor,
    }).map(({ pageIndex, accountName }) => ({ pageIndex, accountName })),
    [{ pageIndex: 0, accountName: "Open" }]
  );

  let displayedRaids = null;
  const lockedAccounts = [accounts[1]];
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => lockedAccounts,
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    getFilterRaidId: () => "kazeros:hard",
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: getRaidsFor,
    totalCharacters: 1,
    summarizeRaidProgress: () => ({ completed: 0, partial: 0, total: 0 }),
    summarizeGlobalGold: () => ({ earned: 0, total: 0 }),
    buildAccountPageEmbed: (
      currentAccount,
      _pageIndex,
      _totalPages,
      _globalTotals,
      getDisplayRaidsFor
    ) => {
      displayedRaids = getDisplayRaidsFor(currentAccount.characters[0]);
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "en",
  });

  buildCurrentEmbed();
  assert.deepEqual(displayedRaids, []);
});

test("raid-status Solo filter includes deferred Normal -> Solo characters without counting them", () => {
  const accounts = [account("Alpha", [{
    raidKey: "kazeros",
    modeKey: "normal",
    pendingModeKey: "solo",
    isCompleted: true,
    goldReceives: true,
  }])];
  const getRaidsFor = (character) => character.raids;

  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "kazeros:solo",
      getRaidsFor,
    }).map(({ pageIndex, pending, success, soloPending, displayMatches }) => ({
      pageIndex,
      pending,
      success,
      soloPending,
      displayMatches,
    })),
    [{ pageIndex: 0, pending: 0, success: 0, soloPending: 0, displayMatches: 1 }],
  );
});

test("raid-status Solo render resolves the same deferred Normal -> Solo filter key", () => {
  const character = {
    raids: [{
      raidKey: "kazeros",
      modeKey: "normal",
      pendingModeKey: "solo",
      isCompleted: true,
      goldReceives: true,
    }],
  };
  const accounts = [{ accountName: "Alpha", characters: [character] }];
  let displayedRaids = null;
  let countedRaids = null;
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    getFilterRaidId: () => "kazeros:solo",
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: (target) => target.raids,
    totalCharacters: 1,
    summarizeRaidProgress: () => ({ completed: 0, partial: 0, total: 0 }),
    summarizeGlobalGold: () => ({ earned: 0, total: 0 }),
    buildAccountPageEmbed: (accountValue, pageIndex, totalPages, totals, getRaidsFor, meta, options) => {
      displayedRaids = getRaidsFor(character);
      countedRaids = options.getProgressRaidsFor(character);
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "en",
  });

  buildCurrentEmbed();
  assert.equal(displayedRaids.length, 1);
  assert.equal(displayedRaids[0].pendingModeKey, "solo");
  assert.deepEqual(countedRaids, []);
});

test("raid-status roster dropdown uses folder icons and selects the paginated roster", () => {
  const row = buildStatusRosterFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    truncateText: (value, limit) => String(value).slice(0, limit),
    rosterFilterEntries: [
      { pageIndex: 0, accountName: "Alpha", pending: 2, success: 1, soloPending: 3 },
      { pageIndex: 3, accountName: "Gamma", pending: 0, success: 4, soloPending: 1 },
    ],
    selectedRosterIndex: 3,
    currentPageIndex: 3,
    includeAllOption: false,
    disabled: false,
    lang: "vi",
  });

  const menu = row.components[0].data;
  assert.equal(menu.customId, "status-filter:roster");
  assert.equal(menu.placeholder, "Lọc theo roster...");
  assert.equal(menu.disabled, false);
  assert.deepEqual(menu.options.map((option) => option.value), [
    "0",
    "3",
  ]);
  assert.equal(menu.options[0].emoji, "📁");
  assert.equal(menu.options[0].label, "Alpha (Còn 2 raid · 3 solo)");
  assert.equal(menu.options[1].label, "Gamma (Còn 0 raid · 1 solo)");
  assert.equal(menu.options[1].default, true);
  assert.equal(t("raid-status.filter.rosterPlaceholder", "jp"), "ロスターで絞り込む...");
});

test("raid-status layout paginates the visible roster list and mirrors its selection", () => {
  let paginationArgs = null;
  const entries = [
    { pageIndex: 0, accountName: "Alpha", pending: 1, success: 0, soloPending: 2 },
    { pageIndex: 2, accountName: "Gamma", pending: 0, success: 1, soloPending: 0 },
  ];
  const makeRow = () => new FakeActionRowBuilder().addComponents({ data: {} });
  const { buildComponents } = createRaidStatusComponentLayout({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    truncateText: (value, limit) => String(value).slice(0, limit),
    lang: "en",
    buildPaginationRow: (currentPage, totalPages) => {
      paginationArgs = { currentPage, totalPages };
      return makeRow();
    },
    buildViewToggleRow: makeRow,
    buildRosterRefreshButton: () => null,
    buildRaidFilterRow: makeRow,
    buildStatusRosterFilterRow,
    buildMyRaidsRow: makeRow,
    getAccounts: () => [
      { accountName: "Alpha" },
      { accountName: "Beta" },
      { accountName: "Gamma" },
    ],
    getCurrentPage: () => 2,
    getCurrentLocalPage: () => 1,
    getVisibleRosterCount: () => 2,
    getCurrentView: () => "raid",
    getStatusUserMeta: () => ({}),
    getRaidDropdownEntries: () => [{ key: "armoche:hard" }],
    getTotalRaidPending: () => 1,
    getFilterRaidId: () => "armoche:hard",
    getRosterFilterEntries: () => entries,
    getSelectedRosterIndex: () => 2,
    getMyRaidsShaped: () => [],
  });

  const rows = buildComponents(false);
  const rosterMenu = rows
    .map((row) => row.components[0]?.data)
    .find((data) => data?.customId === "status-filter:roster");

  assert.deepEqual(paginationArgs, { currentPage: 1, totalPages: 2 });
  assert.ok(rosterMenu, "expected the roster dropdown in raid view");
  assert.equal(rosterMenu.options.some((option) => option.value === FILTER_ALL_ROSTERS), false);
  assert.equal(rosterMenu.options.find((option) => option.value === "2").default, true);
  assert.ok(rows.length <= 5);
});

test("raid-status raid embed footer uses filtered roster pagination", () => {
  const accounts = [
    account("Alpha", []),
    account("Beta", []),
    account("Gamma", []),
  ];
  let renderedPage = null;
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => accounts,
    getCurrentPage: () => 2,
    getCurrentLocalPage: () => 1,
    getVisibleRosterCount: () => 2,
    getCurrentView: () => "raid",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: () => [],
    totalCharacters: 0,
    summarizeRaidProgress: () => ({ completed: 0, partial: 0, total: 0 }),
    summarizeGlobalGold: () => ({ earned: 0, total: 0 }),
    buildAccountPageEmbed: (currentAccount, pageIndex, totalPages) => {
      renderedPage = {
        accountName: currentAccount.accountName,
        pageIndex,
        totalPages,
      };
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "en",
  });

  buildCurrentEmbed();
  assert.deepEqual(renderedPage, {
    accountName: "Gamma",
    pageIndex: 1,
    totalPages: 2,
  });
});

test("raid-status Solo filter renders its detail while progress totals stay zero", () => {
  const soloRaid = {
    raidKey: "armoche",
    modeKey: "solo",
    raidName: "Act 4 Solo",
    completedGateKeys: [],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
    goldReceives: true,
  };
  const accounts = [account("Solo", [soloRaid])];
  let captured = null;
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getCurrentLocalPage: () => 0,
    getVisibleRosterCount: () => 1,
    getCurrentView: () => "raid",
    getFilterRaidId: () => "armoche:solo",
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: (character) => character.raids || [],
    totalCharacters: 1,
    summarizeRaidProgress: (raids) => ({
      completed: raids.filter((raid) => raid.isCompleted).length,
      partial: 0,
      total: raids.length,
    }),
    summarizeGlobalGold: () => ({ earned: 0, total: 0 }),
    buildAccountPageEmbed: (
      currentAccount,
      _pageIndex,
      _totalPages,
      globalTotals,
      getDisplayRaidsFor,
      _userMeta,
      options,
    ) => {
      const character = currentAccount.characters[0];
      captured = {
        globalProgress: globalTotals.progress,
        displayed: getDisplayRaidsFor(character),
        counted: options.getProgressRaidsFor(character),
      };
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "en",
  });

  buildCurrentEmbed();

  assert.equal(captured.globalProgress.total, 0);
  assert.deepEqual(captured.counted, []);
  assert.deepEqual(captured.displayed, [soloRaid]);
});
