// Tests for /raid-add-roster picker flow.
//
// Focus: persistSelectedRoster's account-match + race-safe overlap guard.
// The handler-level Discord interaction surface is not exercised here
// because it requires extensive Discord mocking. The tests call
// persistSelectedRoster through the factory's __test export instead.

process.env.RAID_MANAGER_ID = "test-manager-1";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { createAddRosterCommand } = require("../bot/handlers/roster/add");
const { UI, normalizeName, parseCombatScore, getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");
const { buildCharacterRecord, createCharacterId } = require("../bot/utils/raid/common/character");
const { clearUserLanguageCache, t } = require("../bot/services/i18n");
const { createBibleHttpError } = require("../bot/services/auto-manage/bible/rate-limit");

// In-memory User model stub. findOne returns either a "live" doc (with
// .save) or .lean() returns the plain JSON. save() persists back into
// the in-memory store. JSON-clones around the boundary so mutations to
// the returned doc don't accidentally leak back into the store before
// .save() is called — mirrors Mongoose semantics close enough for the
// persistence logic under test.
function makeUserModel(events = null) {
  const docs = new Map();

  class User {
    constructor(data = {}) {
      this.discordId = data.discordId || null;
      this.accounts = JSON.parse(JSON.stringify(data.accounts || []));
      this.autoManageEnabled = data.autoManageEnabled;
      this.localSyncEnabled = data.localSyncEnabled;
    }
    async save() {
      docs.set(this.discordId, {
        discordId: this.discordId,
        accounts: JSON.parse(JSON.stringify(this.accounts)),
        autoManageEnabled: this.autoManageEnabled,
        localSyncEnabled: this.localSyncEnabled,
      });
      return this;
    }
    static findOne(query) {
      events?.push(`findOne:${query.discordId}`);
      const data = docs.get(query.discordId);
      return {
        async lean() {
          return data ? JSON.parse(JSON.stringify(data)) : null;
        },
        then(resolve, reject) {
          const result = data ? new User(JSON.parse(JSON.stringify(data))) : null;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
    }
  }
  return { User, docs };
}

function makeFactory({ fetchRosterCharacters, events } = {}) {
  const { User, docs } = makeUserModel(events);
  const factory = createAddRosterCommand({
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    MAX_CHARACTERS_PER_ACCOUNT: 25,
    fetchRosterCharacters: fetchRosterCharacters || (async () => []),
    parseCombatScore,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    buildCharacterRecord,
    createCharacterId,
    isManagerId: (id) => id === "test-manager-1",
  });
  return { factory, User, docs };
}

test("handleAddRosterCommand reuses the self lookup and defers before Bible fetch", async () => {
  clearUserLanguageCache();
  const events = [];
  const { factory } = makeFactory({
    events,
    fetchRosterCharacters: async () => {
      events.push("fetchRoster");
      return [];
    },
  });
  const interaction = {
    user: { id: "fresh-self-user" },
    options: {
      getString: () => "FreshSeed",
      getUser: () => null,
    },
    async reply() {
      events.push("reply");
    },
    async deferReply() {
      events.push("deferReply");
    },
    async editReply() {
      events.push("editReply");
    },
  };

  await factory.handleAddRosterCommand(interaction);

  assert.deepEqual(events, [
    "findOne:fresh-self-user",
    "deferReply",
    "fetchRoster",
    "editReply",
  ]);
});

test("handleAddRosterCommand names a Bible rate limit and keeps an unknown error in a code span", async () => {
  clearUserLanguageCache();
  const replies = [];
  for (const failure of [
    createBibleHttpError("LostArk Bible HTTP 429", { status: 429 }),
    new TypeError("fetch failed"),
  ]) {
    const { factory } = makeFactory({
      fetchRosterCharacters: async () => {
        throw failure;
      },
    });
    await factory.handleAddRosterCommand({
      user: { id: "fresh-self-user" },
      options: {
        getString: () => "FreshSeed",
        getUser: () => null,
      },
      async reply() {},
      async deferReply() {},
      async editReply(content) {
        replies.push(content);
      },
    });
  }

  assert.ok(replies[0].includes(t("common.bibleError.rateLimit", "vi")), replies[0]);
  assert.equal(replies[0].includes("HTTP 429"), false);
  assert.ok(replies[1].endsWith("`fetch failed`"), replies[1]);
});

test("handleAddRosterCommand hands its Bible roster names to the Confirm race guard", async () => {
  clearUserLanguageCache();
  const roster = [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    { charName: "Beta", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];
  const { factory, docs } = makeFactory({ fetchRosterCharacters: async () => roster });

  await factory.handleAddRosterCommand({
    user: { id: "user-1" },
    options: {
      getString: () => "Beta",
      getUser: () => null,
    },
    async reply() {},
    async deferReply() {},
    async editReply() {},
  });
  const [session] = factory.__test.sessions.values();
  clearTimeout(session.expireTimer);

  // Between the command and Confirm, another session saved this Bible roster
  // under "Alpha".
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Alpha",
      characters: [{ id: "alpha-id", name: "Alpha", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] }],
    }],
  });

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, [roster[1]]),
    (err) => {
      assert.equal(err.code, "RACE_DUP_ROSTER");
      assert.equal(err.collidingAccountName, "Alpha");
      return true;
    }
  );
  assert.equal(docs.get("user-1").accounts.length, 1);
});

function makeSession({ discordId = "user-1", seedCharName = "Alpha", bibleNames = [] } = {}) {
  return {
    sessionId: "sess-test",
    callerId: discordId,
    targetId: null,
    discordId,
    actingForOther: false,
    seedCharName,
    bibleNames: new Set(bibleNames.map((n) => normalizeName(n))),
    chars: [],
    selectedIndices: new Set(),
    expireTimer: null,
  };
}

test("persistSelectedRoster: creates a new account on a fresh user", async () => {
  const { factory, docs } = makeFactory();
  const session = makeSession({
    seedCharName: "Alpha",
    bibleNames: ["alpha", "beta", "gamma"],
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    { charName: "Beta", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];

  const saved = await factory.__test.persistSelectedRoster(session, selected);

  assert.equal(saved.accountName, "Alpha");
  assert.deepEqual(
    saved.characters.map((c) => c.name),
    ["Alpha", "Beta"]
  );
  // Persisted to the store
  const stored = docs.get("user-1");
  assert.ok(stored);
  assert.equal(stored.accounts.length, 1);
  assert.equal(stored.accounts[0].accountName, "Alpha");
  assert.equal(stored.autoManageEnabled, false);
  assert.equal(stored.localSyncEnabled, true);
});

test("persistSelectedRoster: preserves an existing user's disabled Local Sync choice", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [],
    autoManageEnabled: false,
    localSyncEnabled: false,
  });
  const session = makeSession({ seedCharName: "Alpha", bibleNames: ["alpha"] });

  await factory.__test.persistSelectedRoster(session, [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ]);

  const stored = docs.get("user-1");
  assert.equal(stored.localSyncEnabled, false);
  assert.equal(stored.autoManageEnabled, false);
});

function savedCharacter(name, extra = {}) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel: 1700,
    combatScore: "85000",
    assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
    tasks: [],
    ...extra,
  };
}

function assertRaceDuplicate(accountName) {
  return (err) => {
    assert.equal(err.code, "RACE_DUP_ROSTER");
    assert.equal(err.collidingAccountName, accountName);
    return true;
  };
}

test("persistSelectedRoster: refuses the roster a concurrent picker just saved instead of replacing its characters", async () => {
  // The handler refuses a saved roster when the command runs, so a matching
  // account here was saved by another picker after that check.
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Alpha",
      characters: [
        savedCharacter("Alpha", {
          assignedRaids: { armoche: {}, kazeros: { G1: { difficulty: "Hard", completedDate: 111 } }, serca: {} },
        }),
        savedCharacter("Beta"),
        savedCharacter("Gamma"),
        savedCharacter("Delta"),
      ],
    }],
  });

  const session = makeSession({
    seedCharName: "Alpha",
    bibleNames: ["alpha", "beta", "gamma", "delta"],
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1705, combatScore: "86000" },
  ];

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, selected),
    assertRaceDuplicate("Alpha")
  );

  const stored = docs.get("user-1");
  assert.deepEqual(stored.accounts[0].characters.map((c) => c.name), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.equal(stored.accounts[0].characters[0].assignedRaids.kazeros.G1.completedDate, 111);
});

test("persistSelectedRoster: race-safe guard throws RACE_DUP_ROSTER when another account already covers this bible roster", async () => {
  const { factory, docs } = makeFactory();
  // Concurrent /raid-add-roster session committed first under accountName "Alpha"
  // with one of the bible chars saved.
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          {
            id: "alpha-id",
            name: "Alpha",
            class: "Bard",
            itemLevel: 1700,
            combatScore: "85000",
            assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
            tasks: [],
          },
        ],
      },
    ],
  });

  // This session seeded with "Beta" — a DIFFERENT char in the SAME bible
  // roster — and selected only Beta. Without the race guard, persist
  // would create a SECOND account "Beta", splitting the bible roster.
  const session = makeSession({
    seedCharName: "Beta",
    bibleNames: ["alpha", "beta", "gamma", "delta"],
  });
  const selected = [
    { charName: "Beta", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, selected),
    (err) => {
      assert.equal(err.code, "RACE_DUP_ROSTER");
      assert.equal(err.collidingAccountName, "Alpha");
      return true;
    }
  );

  // Store unchanged — the would-be second account didn't get created.
  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 1);
  assert.equal(stored.accounts[0].accountName, "Alpha");
});

test("persistSelectedRoster: refuses an account named after the seed when Bible gave no roster names", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{ accountName: "Alpha", characters: [savedCharacter("Alpha")] }],
  });

  const session = makeSession({ seedCharName: "Alpha", bibleNames: [] });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ];

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, selected),
    assertRaceDuplicate("Alpha")
  );
  assert.equal(docs.get("user-1").accounts.length, 1);
});

test("persistSelectedRoster: race guard does NOT trigger on unrelated rosters", async () => {
  // User has account "Alpha" (chars [Alpha, Beta]); now adds a totally
  // different roster "Charlie" with chars [Charlie, Delta]. No overlap →
  // no false positive.
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { id: "a-id", name: "Alpha", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
          { id: "b-id", name: "Beta", class: "Paladin", itemLevel: 1690, combatScore: "82000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
        ],
      },
    ],
  });

  const session = makeSession({
    seedCharName: "Charlie",
    bibleNames: ["charlie", "delta"], // disjoint from saved Alpha/Beta
  });
  const selected = [
    { charName: "Charlie", className: "Bard", itemLevel: 1710, combatScore: "87000" },
    { charName: "Delta", className: "Paladin", itemLevel: 1705, combatScore: "85500" },
  ];

  const saved = await factory.__test.persistSelectedRoster(session, selected);
  assert.equal(saved.accountName, "Charlie");

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 2);
  assert.deepEqual(
    stored.accounts.map((a) => a.accountName),
    ["Alpha", "Charlie"]
  );
});

test("persistSelectedRoster: stamps account.lastRefreshedAt for /raid-status lazy-refresh skip", async () => {
  const { factory, docs } = makeFactory();
  const before = Date.now();
  const session = makeSession({ seedCharName: "Alpha", bibleNames: ["alpha"] });
  await factory.__test.persistSelectedRoster(session, [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ]);
  const after = Date.now();
  const stored = docs.get("user-1");
  const stamp = stored.accounts[0].lastRefreshedAt;
  assert.ok(stamp >= before && stamp <= after, `expected lastRefreshedAt in [${before},${after}], got ${stamp}`);
});

test("persistSelectedRoster: refuses a selection that overlaps a saved account under another seed", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { id: "a-id", name: "Alpha", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: { G1: { difficulty: "Hard", completedDate: 999 } }, serca: {} }, tasks: [] },
        ],
      },
    ],
  });

  const session = makeSession({
    seedCharName: "Charlie",
    bibleNames: ["alpha", "beta", "charlie"],
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1705, combatScore: "86000" },
    { charName: "Charlie", className: "Berserker", itemLevel: 1680, combatScore: "80000" },
  ];

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, selected),
    assertRaceDuplicate("Alpha")
  );

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 1, "no second account splits the roster");
  assert.deepEqual(stored.accounts[0].characters.map((c) => c.name), ["Alpha"]);
  assert.equal(stored.accounts[0].characters[0].assignedRaids.kazeros.G1.completedDate, 999);
});

test("persistSelectedRoster: stamps registeredBy with callerId when actingForOther is true", async () => {
  // /raid-add-roster target:U flow: Manager M acts on User U's behalf, so the
  // freshly-created account on U's doc must record M's discordId in
  // `registeredBy`. /raid-set later uses this match to authorize M to
  // keep maintaining U's progress.
  const { factory, docs } = makeFactory();
  const session = {
    sessionId: "sess-mgr-target",
    callerId: "test-manager-1",
    targetId: "user-2",
    discordId: "user-2",
    actingForOther: true,
    seedCharName: "Bravo",
    bibleNames: new Set(["bravo"]),
    chars: [],
    selectedIndices: new Set(),
    expireTimer: null,
  };
  const selected = [
    { charName: "Bravo", className: "Bard", itemLevel: 1730, combatScore: "90000" },
  ];

  await factory.__test.persistSelectedRoster(session, selected);

  const stored = docs.get("user-2");
  assert.equal(stored.accounts.length, 1);
  assert.equal(
    stored.accounts[0].registeredBy,
    "test-manager-1",
    "Manager onboarding flow must stamp the helper's discordId on the new account"
  );
});

test("persistSelectedRoster: leaves registeredBy null when user self-adds", async () => {
  // Self-add path (no `target:` option, actingForOther === false): the
  // /raid-set helper-Manager lookup uses `registeredBy` as the authorization
  // key, so a self-added account MUST stay at the schema default (null) so
  // it never matches a stranger's executor id by accident.
  const { factory, docs } = makeFactory();
  const session = makeSession({
    seedCharName: "Solo",
    bibleNames: ["solo"],
  });
  const selected = [
    { charName: "Solo", className: "Berserker", itemLevel: 1700, combatScore: "85000" },
  ];

  await factory.__test.persistSelectedRoster(session, selected);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 1);
  // Mongoose default is null, but the in-memory test stub doesn't apply
  // schema defaults, so the assertion accepts an unset or falsy field rather
  // than strictly null. The persist code path must NOT be writing a string
  // here.
  assert.ok(
    stored.accounts[0].registeredBy === undefined ||
      stored.accounts[0].registeredBy === null,
    "self-add path must not stamp registeredBy"
  );
});

test("persistSelectedRoster: a manager's concurrent add leaves the saved account and its registeredBy alone", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-2", {
    discordId: "user-2",
    accounts: [
      {
        accountName: "Charlie",
        characters: [
          { id: "c-id", name: "Charlie", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
        ],
        registeredBy: "original-helper",
      },
    ],
  });

  // Session simulates a different caller running /raid-add-roster target:user-2
  // and the merge logic finding the same account.
  const session = {
    sessionId: "sess-other-mgr",
    callerId: "different-manager",
    targetId: "user-2",
    discordId: "user-2",
    actingForOther: true,
    seedCharName: "Charlie",
    bibleNames: new Set(["charlie"]),
    chars: [],
    selectedIndices: new Set(),
    expireTimer: null,
  };
  const selected = [
    { charName: "Charlie", className: "Bard", itemLevel: 1705, combatScore: "86000" },
  ];

  await assert.rejects(
    () => factory.__test.persistSelectedRoster(session, selected),
    assertRaceDuplicate("Charlie")
  );

  const stored = docs.get("user-2");
  assert.equal(stored.accounts.length, 1);
  assert.equal(stored.accounts[0].registeredBy, "original-helper");
});
