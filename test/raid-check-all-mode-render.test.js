"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAllModePageRenderers,
  displayNameForUser,
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

test("all-mode render display name prefers resolved Discord meta", () => {
  assert.equal(
    displayNameForUser({ discordId: "u1", discordUsername: "Saved" }, { displayName: "Fetched" }),
    "Fetched"
  );
  assert.equal(displayNameForUser({ discordId: "u1", discordUsername: "Saved" }, null), "Saved");
  assert.equal(displayNameForUser({ discordId: "u1" }, null), "<@u1>");
});

test("all-mode task page renders current account identity and read-only footer", () => {
  const pagesData = [
    {
      userDoc: { discordId: "u1", discordUsername: "Saved" },
      account: { accountName: "Roster", characters: [] },
    },
  ];
  const { buildTaskPage } = createAllModePageRenderers({
    EmbedBuilder: FakeEmbedBuilder,
    UI: { icons: { done: "done", pending: "pending", reset: "reset" } },
    authorMeta: new Map([["u1", { displayName: "Fetched", avatarURL: "avatar.png" }]]),
    buildAccountPageEmbed: () => new FakeEmbedBuilder(),
    buildStatusFooterText: () => "footer",
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId: null,
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: () => [],
    isManagerId: () => false,
    lang: "en",
    pagesData,
    summarizeRaidProgress: () => ({ completed: 0, total: 0 }),
    truncateText: (value) => String(value),
  });

  const embed = buildTaskPage(0);

  assert.match(embed.data.title, /Fetched/);
  assert.match(embed.data.title, /Roster/);
  assert.deepEqual(embed.data.author, { name: "Fetched", iconURL: "avatar.png" });
  assert.ok(embed.data.footer.text.length > 0);
});

test("all-mode raid page displays gold-locked raids but hides Solo raids entirely", () => {
  const character = {
    name: "Goldie",
    raids: [
      { raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true },
      { raidKey: "kazeros", modeKey: "solo", isCompleted: false, goldReceives: true },
      { raidKey: "horizon", modeKey: "normal", isCompleted: false, goldReceives: false },
    ],
  };
  const pagesData = [
    {
      userDoc: {
        discordId: "u1",
        accounts: [{ accountName: "Roster", characters: [character] }],
      },
      account: { accountName: "Roster", characters: [character] },
    },
  ];
  let capturedDisplayRaids = null;
  let capturedProgressRaids = null;
  let capturedGlobalTotals = null;

  const { buildRaidPage } = createAllModePageRenderers({
    EmbedBuilder: FakeEmbedBuilder,
    UI: { icons: { done: "done", pending: "pending", reset: "reset" } },
    authorMeta: new Map(),
    buildAccountPageEmbed: (account, pageIndex, totalPages, globalTotals, getRaidsFor, userMeta, options) => {
      capturedDisplayRaids = getRaidsFor(character);
      capturedProgressRaids = options.getProgressRaidsFor(character);
      capturedGlobalTotals = globalTotals;
      return new FakeEmbedBuilder().setTitle(account.accountName);
    },
    buildStatusFooterText: (globalTotals) =>
      `${globalTotals.progress.completed}/${globalTotals.progress.total}`,
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId: null,
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: (ch) => ch.raids,
    isManagerId: () => false,
    lang: "en",
    pagesData,
    summarizeRaidProgress: (entries) => ({
      completed: entries.filter((entry) => entry.isCompleted).length,
      total: entries.length,
    }),
    truncateText: (value) => String(value),
  });

  const embed = buildRaidPage(0);

  assert.deepEqual(capturedDisplayRaids.map((raid) => raid.raidKey), ["act4", "horizon"]);
  assert.deepEqual(capturedProgressRaids.map((raid) => raid.raidKey), ["act4"]);
  assert.deepEqual(capturedGlobalTotals.progress, { completed: 0, total: 1 });
  assert.equal(embed.data.footer.text, "0/1");
});

test("all-mode raid page applies Success status per raid entry", () => {
  const mixed = {
    name: "Mixed",
    raids: [
      { raidKey: "act4", modeKey: "hard", isCompleted: false, goldReceives: true },
      { raidKey: "kazeros", modeKey: "hard", isCompleted: true, goldReceives: true },
    ],
  };
  const pendingOnly = {
    name: "PendingOnly",
    raids: [
      { raidKey: "serca", modeKey: "hard", isCompleted: false, goldReceives: true },
    ],
  };
  const account = { accountName: "Roster", characters: [mixed, pendingOnly] };
  let captured = null;

  const { buildRaidPage } = createAllModePageRenderers({
    EmbedBuilder: FakeEmbedBuilder,
    UI: { icons: { done: "done", pending: "pending", reset: "reset" } },
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
    isManagerId: () => false,
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
