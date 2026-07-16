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
    ]),
    account("Beta", [
      { raidKey: "kazeros", modeKey: "normal", isCompleted: true },
    ]),
  ];
  const getRaidsFor = (character) => character.raids;

  assert.deepEqual(
    buildStatusRosterFilterEntries({ accounts, getRaidsFor }).map(
      ({ pageIndex, pending, success }) => ({ pageIndex, pending, success })
    ),
    [
      { pageIndex: 0, pending: 1, success: 0 },
      { pageIndex: 1, pending: 0, success: 1 },
    ]
  );
  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "armoche:hard",
      getRaidsFor,
    }).map(({ pageIndex, pending, success }) => ({ pageIndex, pending, success })),
    [{ pageIndex: 0, pending: 1, success: 0 }]
  );
  assert.deepEqual(
    buildStatusRosterFilterEntries({
      accounts,
      raidFilter: "armoche:solo",
      getRaidsFor,
    }).map(({ pageIndex, pending, success, displayMatches }) => ({
      pageIndex,
      pending,
      success,
      displayMatches,
    })),
    [{ pageIndex: 0, pending: 0, success: 0, displayMatches: 1 }]
  );
});

test("raid-status roster dropdown uses folder icons and selects the paginated roster", () => {
  const row = buildStatusRosterFilterRow({
    ActionRowBuilder: FakeActionRowBuilder,
    StringSelectMenuBuilder: FakeSelectMenuBuilder,
    truncateText: (value, limit) => String(value).slice(0, limit),
    rosterFilterEntries: [
      { pageIndex: 0, accountName: "Alpha", pending: 2, success: 1 },
      { pageIndex: 3, accountName: "Gamma", pending: 0, success: 4 },
    ],
    selectedRosterIndex: 3,
    disabled: false,
    lang: "en",
  });

  const menu = row.components[0].data;
  assert.equal(menu.customId, "status-filter:roster");
  assert.equal(menu.placeholder, "Filter by roster...");
  assert.equal(menu.disabled, false);
  assert.deepEqual(menu.options.map((option) => option.value), [
    FILTER_ALL_ROSTERS,
    "0",
    "3",
  ]);
  assert.equal(menu.options[0].emoji, "📂");
  assert.equal(menu.options[1].emoji, "📁");
  assert.match(menu.options[0].label, /2 pending · 5 success/);
  assert.match(menu.options[2].label, /Gamma \(0 pending · 4 success\)/);
  assert.equal(menu.options[2].default, true);
  assert.equal(t("raid-status.filter.rosterPlaceholder", "jp"), "ロスターで絞り込む...");
});

test("raid-status layout paginates the visible roster list and mirrors its selection", () => {
  let paginationArgs = null;
  const entries = [
    { pageIndex: 0, accountName: "Alpha", pending: 1, success: 0 },
    { pageIndex: 2, accountName: "Gamma", pending: 0, success: 1 },
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
