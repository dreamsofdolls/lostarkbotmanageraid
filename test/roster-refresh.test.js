const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
} = require("../src/services/roster-refresh");
const { normalizeName, foldName, getCharacterName } = require("../src/raid/shared");
const {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
} = require("../src/raid/character");

function makeService(fetchRosterCharacters) {
  return createRosterRefreshService({
    normalizeName,
    foldName,
    getCharacterName,
    formatNextCooldownRemaining: () => null,
    buildFetchedRosterIndexes,
    findFetchedRosterMatchForCharacter,
    fetchRosterCharacters,
  });
}

function makeStaleUser() {
  return {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        lastRefreshedAt: Date.now() - ROSTER_REFRESH_COOLDOWN_MS - 1000,
        characters: [
          {
            name: "Alpha",
            class: "Bard",
            itemLevel: 1700,
          },
        ],
      },
    ],
  };
}

test("collectStaleAccountRefreshes dedupes concurrent refreshes for the same account", async () => {
  let fetchCalls = 0;
  const service = makeService(async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [
      {
        charName: "Alpha",
        className: "Bard",
        itemLevel: 1710,
        combatScore: "90000",
      },
    ];
  });

  const [first, second] = await Promise.all([
    service.collectStaleAccountRefreshes(makeStaleUser()),
    service.collectStaleAccountRefreshes(makeStaleUser()),
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].fetchedChars[0].charName, "Alpha");
  assert.equal(second[0].fetchedChars[0].charName, "Alpha");
});

test("hasStaleAccountRefreshes returns false for fresh accounts and true for expired ones", () => {
  const service = makeService(async () => []);
  const freshUser = makeStaleUser();
  freshUser.accounts[0].lastRefreshedAt = Date.now();

  assert.equal(service.hasStaleAccountRefreshes(freshUser), false);
  assert.equal(service.hasStaleAccountRefreshes(makeStaleUser()), true);
});
