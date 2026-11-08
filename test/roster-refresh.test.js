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

test("a failed account refresh names why it failed", async () => {
  const user = makeStaleUser();
  user.accounts[0].characters.push({ name: "Beta", class: "Bard", itemLevel: 1700 });
  const failureKindFor = async (fetchRosterCharacters) => {
    const result = await makeService(fetchRosterCharacters).collectAccountRefresh(user, "Alpha");
    return result.failureKind;
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await failureKindFor(async () => { throw new Error("LostArk Bible HTTP 429"); }), "rateLimit");
    // Bible answers an unknown character with an empty roster page.
    assert.equal(await failureKindFor(async () => []), "notFound");
    assert.equal(await failureKindFor(async () => { throw new Error("LostArk Bible HTTP 500"); }), "other");
    assert.equal(await failureKindFor(async () => [{ charName: "Stranger", itemLevel: 1700 }]), "other");
  } finally {
    console.warn = originalWarn;
  }
});

test("collectStaleAccountRefreshes stays quiet while the global Bible backoff is active", async () => {
  const service = makeService(async () => {
    const error = new Error("LostArk Bible HTTP 429 - global backoff active for 42s");
    error.status = 429;
    error.isBibleBackoff = true;
    throw error;
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await service.collectStaleAccountRefreshes(makeStaleUser());
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
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

// ─── Renamed characters ─────────────────────────────────────────────────────
// lostark.bible keeps a character's id (`cid`) through a rename, and the roster
// page lists it beside each name. The refresh follows a saved character whose
// name is gone from the roster to the roster character with its cid.

function refreshAccount(service, characters, fetchedChars, accountName = "Chixpaul") {
  const user = {
    discordId: "user-1",
    accounts: [{ accountName, lastRefreshedAt: 0, characters }],
  };
  const didUpdate = service.applyStaleAccountRefreshes(user, [
    { accountName, attempted: true, resolvedSeed: accountName, fetchedChars },
  ]);
  return { didUpdate, account: user.accounts[0] };
}

function renamedCharacter() {
  return {
    id: "char-zedaxpaul",
    name: "Zedaxpaul",
    class: "Souleater",
    itemLevel: 1750,
    combatScore: "6000",
    isGoldEarner: false,
    bibleSerial: "200000067680670",
    bibleCid: 291570,
    bibleRid: 211957,
    assignedRaids: {
      serca: {
        modeKey: "nightmare",
        G1: { difficulty: "Nightmare", completedDate: 1794066141790 },
        G2: { difficulty: "Nightmare", completedDate: null },
      },
    },
    sideTasks: [{ taskId: "una", name: "Una dailies", reset: "daily", completed: true }],
  };
}

test("a character renamed on bible is renamed in place by its bible character id", () => {
  const service = makeService(async () => []);
  const before = renamedCharacter();
  const { didUpdate, account } = refreshAccount(service, [
    { name: "Chixpaul", class: "Wildsoul", itemLevel: 1750, bibleCid: 106427776 },
    renamedCharacter(),
  ], [
    { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, combatScore: "4000", cid: 106427776 },
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "≈7139.95", cid: 291570 },
  ]);

  const renamed = account.characters[1];
  assert.equal(didUpdate, true);
  assert.equal(account.characters.length, 2);
  assert.equal(renamed.name, "Sunxpaul");
  assert.equal(renamed.itemLevel, 1781.67);
  assert.equal(renamed.combatScore, "≈7139.95");
  assert.equal(renamed.class, "Souleater");
  assert.equal(renamed.id, before.id);
  assert.equal(renamed.bibleSerial, before.bibleSerial);
  assert.equal(renamed.bibleCid, before.bibleCid);
  assert.equal(renamed.bibleRid, before.bibleRid);
  assert.equal(renamed.isGoldEarner, false);
  assert.deepEqual(renamed.assignedRaids, before.assignedRaids);
  assert.deepEqual(renamed.sideTasks, before.sideTasks);
});

test("a rename alone counts as a refreshed roster", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [renamedCharacter()], [
    { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, cid: 106427776 },
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, cid: 291570 },
  ]);

  assert.equal(account.characters[0].name, "Sunxpaul");
  assert.ok(account.lastRefreshedAt > 0, "the success stamp is written");
});

test("a refresh records the bible character id a saved character lacks, and keeps a different one", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    { name: "Alpha", class: "Bard", itemLevel: 1700 },
    { name: "Beta", class: "Bard", itemLevel: 1700, bibleCid: 7 },
  ], [
    { charName: "Alpha", className: "Bard", itemLevel: 1710, cid: 1 },
    { charName: "Beta", className: "Bard", itemLevel: 1710, cid: 8 },
  ], "Alpha");

  assert.equal(account.characters[0].bibleCid, 1);
  assert.equal(account.characters[0].bibleSerial ?? null, null);
  assert.equal(account.characters[1].bibleCid, 7);
});

test("a case-only rename clears the old bible ids and records the character id again", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    { name: "alpha", class: "Bard", itemLevel: 1700, bibleSerial: "s-1", bibleCid: 1, bibleRid: 9 },
  ], [
    { charName: "Alpha", className: "Bard", itemLevel: 1710, cid: 1 },
  ], "Alpha");

  const [character] = account.characters;
  assert.equal(character.name, "Alpha");
  assert.equal(character.bibleSerial, null);
  assert.equal(character.bibleRid, null);
  assert.equal(character.bibleCid, 1);
});

test("a saved character with no bible character id is not renamed", () => {
  const service = makeService(async () => []);
  const character = renamedCharacter();
  delete character.bibleCid;
  const { account } = refreshAccount(service, [character], [
    { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, cid: 106427776 },
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, cid: 291570 },
  ]);

  assert.equal(account.characters[0].name, "Zedaxpaul");
});

test("a roster without bible character ids renames nothing", () => {
  const service = makeService(async () => []);
  const character = renamedCharacter();
  delete character.bibleCid;
  const { account } = refreshAccount(service, [character], [
    { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750 },
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67 },
  ]);

  assert.equal(account.characters[0].name, "Zedaxpaul");
});

test("two saved characters with one bible character id rename only the first", () => {
  const service = makeService(async () => []);
  const duplicate = { ...renamedCharacter(), id: "char-duplicate", name: "Zedaxpaul2" };
  const { account } = refreshAccount(service, [renamedCharacter(), duplicate], [
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, cid: 291570 },
  ]);

  assert.deepEqual(account.characters.map((c) => c.name), ["Sunxpaul", "Zedaxpaul2"]);
});

test("a renamed character the user already re-added is not renamed over it", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    renamedCharacter(),
    { name: "Sunxpaul", class: "Souleater", itemLevel: 1781.67 },
  ], [
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, cid: 291570 },
  ]);

  assert.deepEqual(account.characters.map((c) => c.name), ["Zedaxpaul", "Sunxpaul"]);
  assert.equal(account.characters[1].bibleCid, 291570);
});

test("a rename found by character id records the old name and when it happened", () => {
  const before = Date.now();
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [renamedCharacter()], [
    { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, cid: 106427776 },
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, cid: 291570 },
  ]);

  const [character] = account.characters;
  assert.equal(character.renamedFrom, "Zedaxpaul");
  assert.ok(character.renamedAt >= before);
});

test("a refresh that only corrects a name's case leaves no rename note", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    { name: "alpha", class: "Bard", itemLevel: 1700, bibleCid: 1 },
  ], [
    { charName: "Alpha", className: "Bard", itemLevel: 1710, cid: 1 },
  ], "Alpha");

  assert.equal(account.characters[0].name, "Alpha");
  assert.equal(account.characters[0].renamedFrom ?? "", "");
});

test("the user schema keeps a character's rename note", () => {
  const User = require("../bot/models/user");
  const user = new User({
    discordId: "user-1",
    accounts: [{
      accountName: "Chixpaul",
      characters: [{
        id: "c1", name: "Sunxpaul", class: "Souleater", itemLevel: 1781, renamedFrom: "Zedaxpaul", renamedAt: 5,
      }],
    }],
  });

  const [character] = user.accounts[0].characters;
  assert.equal(character.renamedFrom, "Zedaxpaul");
  assert.equal(character.renamedAt, 5);
});

test("/raid-check loads a character's rename note", () => {
  const { RAID_CHECK_USER_QUERY_FIELDS } = require("../bot/utils/raid/queries/raid-check");
  const fields = String(RAID_CHECK_USER_QUERY_FIELDS);

  assert.match(fields, /accounts\.characters\.renamedFrom/u);
  assert.match(fields, /accounts\.characters\.renamedAt/u);
});

test("an accent-only name match gives way to a different bible character id", () => {
  // Saved Zoe (cid 10) was renamed to Zed; Zoë (cid 11) is another character
  // on the same roster. The id, not the folded name, decides.
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    { name: "Main", class: "Bard", itemLevel: 1700, bibleCid: 1 },
    { name: "Zoe", class: "Bard", itemLevel: 1700, bibleSerial: "sn-10", bibleCid: 10, bibleRid: 5 },
  ], [
    { charName: "Main", className: "Bard", itemLevel: 1700, cid: 1 },
    { charName: "Zoë", className: "Bard", itemLevel: 1701, cid: 11 },
    { charName: "Zed", className: "Bard", itemLevel: 1710, cid: 10 },
  ], "Main");

  const zoe = account.characters[1];
  assert.equal(zoe.name, "Zed");
  assert.equal(zoe.bibleCid, 10);
  assert.equal(zoe.bibleSerial, "sn-10");
});

test("an accent-only name match with the same bible character id still renames", () => {
  const service = makeService(async () => []);
  const { account } = refreshAccount(service, [
    { name: "Main", class: "Bard", itemLevel: 1700, bibleCid: 1 },
    { name: "Zoe", class: "Bard", itemLevel: 1700, bibleCid: 11 },
  ], [
    { charName: "Main", className: "Bard", itemLevel: 1700, cid: 1 },
    { charName: "Zoë", className: "Bard", itemLevel: 1701, cid: 11 },
  ], "Main");

  assert.equal(account.characters[1].name, "Zoë");
  assert.equal(account.characters[1].bibleCid, 11);
});
