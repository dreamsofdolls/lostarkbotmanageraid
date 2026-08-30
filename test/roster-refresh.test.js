const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
} = require("../bot/services/roster/refresh");
const { normalizeName, foldName, getCharacterName } = require("../bot/utils/raid/common/shared");
const {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
} = require("../bot/utils/raid/common/character");

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

test("collectAccountRefresh bypasses stale cooldown for manual button refresh", async () => {
  let fetchCalls = 0;
  const service = makeService(async () => {
    fetchCalls += 1;
    return [
      {
        charName: "Alpha",
        className: "Bard",
        itemLevel: 1715,
        combatScore: "91000",
      },
    ];
  });
  const user = makeStaleUser();
  user.accounts[0].lastRefreshedAt = Date.now();

  assert.deepEqual(await service.collectStaleAccountRefreshes(user), []);

  const result = await service.collectAccountRefresh(user, "Alpha");
  assert.equal(fetchCalls, 1);
  assert.equal(result.attempted, true);
  assert.equal(result.fetchedChars?.[0]?.itemLevel, 1715);
});

test("collectStaleAccountRefreshes aborts seed loop on first HTTP 429", async () => {
  let fetchCalls = 0;
  const service = makeService(async () => {
    fetchCalls += 1;
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

  // Account has 4 seeds (Alpha account name + Alpha/Beta/Gamma chars; Alpha
  // dedupes via the `!seeds.includes(name)` guard so 3 unique seeds). The
  // abort-on-first guard stops the loop after the first throw so subsequent
  // seeds never burn extra bible requests under the same rate-limit window.
  assert.equal(fetchCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account "Alpha" aborted on first LostArk Bible HTTP 429/);
  assert.doesNotMatch(warnings[0], /seed "Alpha" failed/);
});

test("collectStaleAccountRefreshes keeps iterating seeds on non-429 errors", async () => {
  let fetchCalls = 0;
  const service = makeService(async (seed) => {
    fetchCalls += 1;
    if (seed === "Beta") {
      return [
        {
          charName: "Alpha",
          className: "Bard",
          itemLevel: 1720,
          combatScore: "92000",
        },
      ];
    }
    throw new Error(`seed "${seed}" not found on bible`);
  });
  const user = makeStaleUser();
  user.accounts[0].characters.push({ name: "Beta", class: "Bard", itemLevel: 1700 });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await service.collectStaleAccountRefreshes(user);
    assert.equal(result.length, 1);
    assert.equal(result[0].attempted, true);
    assert.equal(result[0].fetchedChars?.length, 1);
    assert.equal(result[0].fetchedChars[0].itemLevel, 1720);
  } finally {
    console.warn = originalWarn;
  }

  // Alpha seed throws non-rate-limit "not found", loop continues to Beta
  // which returns the roster successfully. fetchCalls = 2.
  assert.equal(fetchCalls, 2);
});

test("collectStaleAccountRefreshes normalizes duplicate seed names before Bible requests", async () => {
  const fetchedSeeds = [];
  const service = makeService(async (seed) => {
    fetchedSeeds.push(seed);
    if (normalizeName(seed) === "beta") {
      return [
        {
          charName: "Alpha",
          className: "Bard",
          itemLevel: 1725,
          combatScore: "92500",
        },
      ];
    }
    return [];
  });
  const user = makeStaleUser();
  user.accounts[0].accountName = " Alpha ";
  user.accounts[0].characters.push(
    { name: "alpha", class: "Bard", itemLevel: 1700 },
    { name: "ALPHA", class: "Bard", itemLevel: 1700 },
    { name: "Beta", class: "Bard", itemLevel: 1700 }
  );

  const result = await service.collectStaleAccountRefreshes(user);

  assert.deepEqual(fetchedSeeds, ["Alpha", "Beta"]);
  assert.equal(result[0].fetchedChars?.[0]?.itemLevel, 1725);
});

test("applyStaleAccountRefreshes preserves assigned raid mode preference", () => {
  const service = makeService(async () => []);
  const user = makeStaleUser();
  user.accounts[0].characters[0].assignedRaids = {
    kazeros: {
      modeKey: "normal",
      G1: { difficulty: "Normal", completedDate: null },
      G2: { difficulty: "Normal", completedDate: null },
    },
  };

  const didUpdate = service.applyStaleAccountRefreshes(user, [
    {
      accountName: "Alpha",
      attempted: true,
      resolvedSeed: "Alpha",
      fetchedChars: [
        {
          charName: "Alpha",
          className: "Bard",
          itemLevel: 1730,
          combatScore: "91000",
        },
      ],
    },
  ]);

  const char = user.accounts[0].characters[0];
  assert.equal(didUpdate, true);
  assert.equal(char.itemLevel, 1730);
  assert.equal(char.combatScore, "91000");
  assert.equal(char.assignedRaids.kazeros.modeKey, "normal");
  assert.equal(char.assignedRaids.kazeros.G1.difficulty, "Normal");
  assert.equal(char.assignedRaids.kazeros.G2.difficulty, "Normal");
});

test("applyStaleAccountRefreshes updates collision counts after each rename", () => {
  const service = makeService(async () => []);
  const user = {
    discordId: "user-1",
    accounts: [
      { accountName: "Alpha", characters: [{ name: "AlphaChar", class: "Bard" }] },
      { accountName: "Beta", characters: [{ name: "BetaChar", class: "Artist" }] },
    ],
  };

  service.applyStaleAccountRefreshes(user, [
    {
      accountName: "Alpha",
      attempted: true,
      resolvedSeed: "SharedName",
      fetchedChars: [{ charName: "AlphaChar", className: "Bard", itemLevel: 1700 }],
    },
    {
      accountName: "Beta",
      attempted: true,
      resolvedSeed: "SharedName",
      fetchedChars: [{ charName: "BetaChar", className: "Artist", itemLevel: 1700 }],
    },
  ]);

  assert.deepEqual(user.accounts.map((account) => account.accountName), ["SharedName", "Beta"]);
});

test("applyStaleAccountRefreshes indexes account-name collisions once", () => {
  const service = makeService(async () => []);
  const accountCount = 120;
  let accountReads = 0;
  const rawAccounts = Array.from({ length: accountCount }, (_, index) => ({
    accountName: `Account-${index}`,
    characters: [{ name: `Character-${index}`, class: "Artist" }],
  }));
  const accounts = new Proxy(rawAccounts, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) accountReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const collected = rawAccounts.map((account, index) => ({
    accountName: account.accountName,
    attempted: true,
    resolvedSeed: `Renamed-${index}`,
    fetchedChars: [{
      charName: `Character-${index}`,
      className: "Artist",
      itemLevel: 1700,
    }],
  }));

  const didUpdate = service.applyStaleAccountRefreshes({ discordId: "user-1", accounts }, collected);

  assert.equal(didUpdate, true);
  assert.equal(rawAccounts.at(-1).accountName, `Renamed-${accountCount - 1}`);
  assert.ok(
    accountReads < accountCount * 5,
    `expected linear account reads, received ${accountReads}`,
  );
});
