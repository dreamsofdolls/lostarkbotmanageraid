"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRosterRefreshService } = require("../bot/services/roster/refresh");
const { createManualRosterRefreshRunner } = require("../bot/services/roster/manual-refresh");
const shared = require("../bot/utils/raid/common/shared");
const rosterMatching = require("../bot/utils/raid/common/character/roster-matching");

// A user store whose findOne returns a saveable copy, like a Mongoose doc.
function createStore(accounts) {
  const store = { discordId: "u1", accounts };
  const findOne = async () => {
    const doc = JSON.parse(JSON.stringify(store));
    doc.save = async function save() {
      const { save: _save, ...rest } = this;
      Object.assign(store, JSON.parse(JSON.stringify(rest)));
    };
    return doc;
  };
  return { store, User: { findOne } };
}

function createRunner(User, fetchRosterCharacters) {
  const service = createRosterRefreshService({
    normalizeName: shared.normalizeName,
    foldName: shared.foldName,
    getCharacterName: shared.getCharacterName,
    formatNextCooldownRemaining: shared.formatNextCooldownRemaining,
    ...rosterMatching,
    fetchRosterCharacters,
  });
  return createManualRosterRefreshRunner({
    User,
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => false,
    normalizeName: shared.normalizeName,
    collectAccountRefresh: service.collectAccountRefresh,
    applyStaleAccountRefreshes: service.applyStaleAccountRefreshes,
  });
}

const BIBLE_ROSTER = [
  { charName: "Alpha", className: "Bard", itemLevel: 1710 },
  { charName: "Beta", className: "Berserker", itemLevel: 1695 },
];

test("a manual refresh that renames the roster to its seed character reports the update", async () => {
  // "My Roster" is not a character on Bible, so the refresh resolves the
  // roster through Alpha and renames the account to it.
  const { store, User } = createStore([{
    accountName: "My Roster",
    lastRefreshedAt: 0,
    characters: [
      { id: "a", name: "Alpha", class: "Bard", itemLevel: 1700 },
      { id: "b", name: "Beta", class: "Berserker", itemLevel: 1690 },
    ],
  }]);
  const { runManualRosterRefresh } = createRunner(User, async (seed) =>
    (shared.normalizeName(seed) === "my roster" ? [] : BIBLE_ROSTER)
  );

  const result = await runManualRosterRefresh("u1", "My Roster");

  assert.equal(store.accounts[0].accountName, "Alpha");
  assert.equal(store.accounts[0].characters[0].itemLevel, 1710);
  assert.equal(result.status, "updated");
  assert.equal(result.accountName, "Alpha");
});

test("a manual refresh keeps reporting under the old name when the seed name is taken", async () => {
  // Another roster is already called Alpha, so this one is not renamed.
  const { store, User } = createStore([
    {
      accountName: "My Roster",
      lastRefreshedAt: 0,
      characters: [
        { id: "a", name: "Alpha", class: "Bard", itemLevel: 1700 },
        { id: "b", name: "Beta", class: "Berserker", itemLevel: 1690 },
      ],
    },
    { accountName: "Alpha", lastRefreshedAt: 0, characters: [] },
  ]);
  const { runManualRosterRefresh } = createRunner(User, async (seed) =>
    (shared.normalizeName(seed) === "my roster" ? [] : BIBLE_ROSTER)
  );

  const result = await runManualRosterRefresh("u1", "My Roster");

  assert.equal(store.accounts[0].accountName, "My Roster");
  assert.equal(result.status, "updated");
  assert.equal(result.accountName, "My Roster");
});

test("a manager's roster is due for its automatic refresh after the manager cooldown, not the regular one", async () => {
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
  const account = () => ({
    accountName: "Alpha",
    lastRefreshedAt: thirtyMinutesAgo,
    characters: [{ id: "a", name: "Alpha", class: "Bard", itemLevel: 1700 }],
  });
  const fetched = [];
  const service = createRosterRefreshService({
    normalizeName: shared.normalizeName,
    foldName: shared.foldName,
    getCharacterName: shared.getCharacterName,
    formatNextCooldownRemaining: shared.formatNextCooldownRemaining,
    ...rosterMatching,
    fetchRosterCharacters: async (seed) => {
      fetched.push(seed);
      return BIBLE_ROSTER;
    },
    getRosterRefreshCooldownMs: (discordId) => (discordId === "manager" ? 10 * 60 * 1000 : 2 * 60 * 60 * 1000),
  });
  const managerDoc = { discordId: "manager", accounts: [account()] };
  const regularDoc = { discordId: "regular", accounts: [account()] };

  assert.equal(service.hasStaleAccountRefreshes(managerDoc), true);
  assert.equal(service.hasStaleAccountRefreshes(regularDoc), false);
  assert.equal((await service.collectStaleAccountRefreshes(managerDoc)).length, 1);
  assert.equal((await service.collectStaleAccountRefreshes(regularDoc)).length, 0);
  assert.deepEqual(fetched, ["Alpha"]);
});
