"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAllModePageRenderers,
} = require("../bot/handlers/raid-check/all-mode/all-mode-render");

class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }

  setAuthor(author) {
    this.data.author = author;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }
}

test("all-mode raid page hides Solo, gold-locked raids, and hidden-only characters", () => {
  const character = {
    name: "Goldie",
    itemLevel: 1730,
    raids: [
      { raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true },
      { raidKey: "kazeros", modeKey: "solo", isCompleted: false, goldReceives: true },
      { raidKey: "horizon", modeKey: "normal", isCompleted: false, goldReceives: false },
    ],
  };
  const hiddenOnlyCharacter = {
    name: "HiddenOnly",
    itemLevel: 1730,
    raids: [
      { raidKey: "kazeros", modeKey: "solo", isCompleted: false, goldReceives: true },
      { raidKey: "horizon", modeKey: "normal", isCompleted: false, goldReceives: false },
    ],
  };
  const pagesData = [
    {
      userDoc: {
        discordId: "u1",
        accounts: [{ accountName: "Roster", characters: [character, hiddenOnlyCharacter] }],
      },
      account: { accountName: "Roster", characters: [character, hiddenOnlyCharacter] },
    },
  ];
  let capturedDisplayRaids = null;
  let capturedProgressRaids = null;
  let capturedGlobalTotals = null;
  let capturedShowGoldEarnerHint = null;
  let capturedVisibleCharacters = null;
  let filterRaidId = null;

  const { buildRaidPage } = createAllModePageRenderers({
    authorMeta: new Map(),
    buildAccountPageEmbed: (account, pageIndex, totalPages, globalTotals, getRaidsFor, userMeta, options) => {
      capturedDisplayRaids = getRaidsFor(character);
      capturedProgressRaids = options.getProgressRaidsFor(character);
      capturedGlobalTotals = globalTotals;
      capturedShowGoldEarnerHint = options.showGoldEarnerHint;
      capturedVisibleCharacters = account.characters
        .filter(options.shouldDisplayCharacter)
        .map((entry) => entry.name);
      return new FakeEmbedBuilder().setTitle(account.accountName);
    },
    buildStatusFooterText: (globalTotals) =>
      `${globalTotals.progress.completed}/${globalTotals.progress.total}`,
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId,
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: (ch) => ch.raids,
    lang: "en",
    pagesData,
    summarizeRaidProgress: (entries) => ({
      completed: entries.filter((entry) => entry.isCompleted).length,
      total: entries.length,
    }),
    truncateText: (value) => String(value),
  });

  const embed = buildRaidPage(0);

  assert.deepEqual(capturedDisplayRaids.map((raid) => raid.raidKey), ["act4"]);
  assert.deepEqual(capturedProgressRaids.map((raid) => raid.raidKey), ["act4"]);
  assert.deepEqual(capturedGlobalTotals.progress, { completed: 0, total: 1 });
  assert.equal(capturedShowGoldEarnerHint, false);
  assert.deepEqual(capturedVisibleCharacters, ["Goldie"]);
  assert.equal(embed.data.footer.text, "0/1");

  filterRaidId = "horizon:normal";
  buildRaidPage(0);

  assert.deepEqual(capturedDisplayRaids, []);
  assert.deepEqual(capturedProgressRaids, []);
  assert.deepEqual(capturedGlobalTotals.progress, { completed: 0, total: 0 });
});

test("all-mode raid page applies Success status per raid entry", () => {
  const mixed = {
    name: "Mixed",
    itemLevel: 1730,
    raids: [
      { raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true },
      { raidKey: "kazeros", modeKey: "hard", isCompleted: true, goldReceives: true },
    ],
  };
  const pendingOnly = {
    name: "PendingOnly",
    itemLevel: 1730,
    raids: [
      { raidKey: "serca", modeKey: "hard", isCompleted: false, goldReceives: true },
    ],
  };
  const account = { accountName: "Roster", characters: [mixed, pendingOnly] };
  let captured = null;

  const { buildRaidPage } = createAllModePageRenderers({
    authorMeta: new Map(),
    buildAccountPageEmbed: (currentAccount, pageIndex, totalPages, globalTotals, getRaidsFor, userMeta, options) => {
      captured = {
        mixed: getRaidsFor(mixed),
        pendingOnly: getRaidsFor(pendingOnly),
        globalTotals,
        hideIneligibleChars: options.hideIneligibleChars,
      };
      return new FakeEmbedBuilder().setTitle(currentAccount.accountName);
    },
    buildStatusFooterText: () => "footer",
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId: null,
      filterStatus: "success",
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: (character) => character.raids,
    lang: "en",
    pagesData: [{ userDoc: { discordId: "u1", accounts: [account] }, account }],
    summarizeRaidProgress: (entries) => ({
      completed: entries.filter((entry) => entry.isCompleted).length,
      total: entries.length,
    }),
    truncateText: (value) => String(value),
  });

  buildRaidPage(0);

  assert.deepEqual(captured.mixed.map((raid) => raid.raidKey), ["kazeros"]);
  assert.deepEqual(captured.pendingOnly, []);
  assert.deepEqual(captured.globalTotals.progress, { completed: 1, total: 1 });
  assert.equal(captured.hideIneligibleChars, true);
});

test("all-mode raid page reuses a user's rollup while paginating their rosters", () => {
  const firstCharacter = {
    name: "First",
    itemLevel: 1730,
    raids: [{ raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true }],
  };
  const secondCharacter = {
    name: "Second",
    itemLevel: 1730,
    raids: [{ raidKey: "kazeros", modeKey: "hard", isCompleted: true, goldReceives: true }],
  };
  const accounts = [
    { accountName: "First roster", characters: [firstCharacter] },
    { accountName: "Second roster", characters: [secondCharacter] },
  ];
  const userDoc = { discordId: "u1", accounts };
  const pagesData = accounts.map((account) => ({ userDoc, account }));
  let rollupCalls = 0;
  let raidDerivationCalls = 0;
  let currentLocalPage = 0;

  const { buildRaidPage } = createAllModePageRenderers({
    authorMeta: new Map(),
    buildAccountPageEmbed: (account) => new FakeEmbedBuilder().setTitle(account.accountName),
    buildStatusFooterText: () => "footer",
    getState: () => ({
      currentLocalPage,
      filterRaidId: null,
      filterStatus: "all",
      filterUserId: "u1",
      filteredIndices: [0, 1],
    }),
    getStatusRaidsForCharacter: (character) => {
      raidDerivationCalls += 1;
      return character.raids;
    },
    lang: "en",
    pagesData,
    summarizeRaidProgress: (entries) => {
      rollupCalls += 1;
      return { completed: 0, total: entries.length };
    },
    truncateText: (value) => String(value),
  });

  buildRaidPage(0);
  currentLocalPage = 1;
  buildRaidPage(1);

  assert.equal(rollupCalls, 1);
  assert.equal(raidDerivationCalls, 2);
});

test("all-mode raid page leaves out characters below 1720 and characters with no raid", () => {
  const main = {
    name: "Main",
    itemLevel: 1730,
    raids: [{ raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true }],
  };
  const normalAlt = {
    name: "NormalAlt",
    itemLevel: 1710,
    raids: [{ raidKey: "kazeros", modeKey: "normal", isCompleted: false, goldReceives: true }],
  };
  const noRaidAlt = { name: "NoRaidAlt", itemLevel: 1690, raids: [] };
  const characters = [main, normalAlt, noRaidAlt];
  const pagesData = [{
    userDoc: { discordId: "u1", accounts: [{ accountName: "Roster", characters }] },
    account: { accountName: "Roster", characters },
  }];
  let visibleNames = null;
  let globalTotals = null;

  const { buildRaidPage } = createAllModePageRenderers({
    authorMeta: new Map(),
    buildAccountPageEmbed: (account, pageIndex, totalPages, totals, getRaidsFor, userMeta, options) => {
      visibleNames = account.characters.filter(options.shouldDisplayCharacter).map((entry) => entry.name);
      globalTotals = totals;
      return new FakeEmbedBuilder().setTitle(account.accountName);
    },
    buildStatusFooterText: (totals) => `${totals.progress.completed}/${totals.progress.total}`,
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId: null,
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: (character) => character.raids,
    lang: "en",
    pagesData,
    summarizeRaidProgress: (entries) => ({
      completed: entries.filter((entry) => entry.isCompleted).length,
      total: entries.length,
    }),
    truncateText: (value) => String(value),
  });

  buildRaidPage(0);

  assert.deepEqual(visibleNames, ["Main"]);
  assert.deepEqual(globalTotals.progress, { completed: 0, total: 1 });
  assert.equal(globalTotals.characters, 3);
});
