const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
} = require("../bot/services/roster-refresh");
const { normalizeName, foldName, getCharacterName } = require("../bot/utils/raid/shared");
const {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
} = require("../bot/utils/raid/character");

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

test("collectStaleAccountRefreshes summarizes repeated HTTP 429 seed failures", async () => {
  const service = makeService(async () => {
    throw new Error("LostArk Bible HTTP 429");
  });
  const user = makeStaleUser();
  user.accounts[0].characters.push(
    { name: "Beta", class: "Bard", itemLevel: 1700 },
    { name: "Gamma", class: "Bard", itemLevel: 1700 }
  );

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await service.collectStaleAccountRefreshes(user);
    assert.equal(result.length, 1);
    assert.equal(result[0].attempted, true);
    assert.equal(result[0].fetchedChars, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account "Alpha" 3 seed\(s\) hit LostArk Bible HTTP 429/);
  assert.doesNotMatch(warnings[0], /seed "Alpha" failed/);
});
