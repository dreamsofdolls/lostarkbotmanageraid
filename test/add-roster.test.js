// Tests for /add-roster picker flow.
//
// Focus: persistSelectedRoster's account-match + race-safe overlap guard.
// These are the two pieces Codex flagged bugs in (commits 4b94664 +
// a5dc054). The handler-level Discord interaction surface is not
// exercised here — too much mocking for too little signal. Instead we
// drive persistSelectedRoster directly via the factory's __test export.

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

const { createAddRosterCommand } = require("../src/commands/add-roster");
const { UI, normalizeName, parseCombatScore, getCharacterName, getCharacterClass } = require("../src/raid/shared");
const { buildCharacterRecord, createCharacterId } = require("../src/raid/character");

// In-memory User model stub. findOne returns either a "live" doc (with
// .save) or .lean() returns the plain JSON. save() persists back into
// the in-memory store. JSON-clones around the boundary so mutations to
// the returned doc don't accidentally leak back into the store before
// .save() is called — mirrors Mongoose semantics close enough for the
// persist logic we're testing.
function makeUserModel() {
  const docs = new Map();

  class User {
    constructor(data = {}) {
      this.discordId = data.discordId || null;
      this.accounts = JSON.parse(JSON.stringify(data.accounts || []));
    }
    async save() {
      docs.set(this.discordId, {
        discordId: this.discordId,
        accounts: JSON.parse(JSON.stringify(this.accounts)),
      });
      return this;
    }
    static findOne(query) {
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

function makeFactory({ fetchRosterCharacters } = {}) {
  const { User, docs } = makeUserModel();
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
});

test("persistSelectedRoster: matches existing account by name and merges new chars", async () => {
  const { factory, docs } = makeFactory();
  // Pre-existing account "Alpha" with one char.
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          {
            id: "char-alpha-id",
            name: "Alpha",
            class: "Bard",
            itemLevel: 1700,
            combatScore: "85000",
            assignedRaids: { armoche: {}, kazeros: { G1: { difficulty: "Hard", completedDate: 111 } }, serca: {} },
            tasks: [],
            bibleSerial: "serial-alpha",
            bibleCid: "cid-alpha",
            bibleRid: "rid-alpha",
            publicLogDisabled: true,
          },
        ],
      },
    ],
  });

  const session = makeSession({
    seedCharName: "Alpha",
    bibleNames: ["alpha", "beta"],
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1705, combatScore: "86000" },
    { charName: "Beta", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];

  const saved = await factory.__test.persistSelectedRoster(session, selected);

  assert.equal(saved.characters.length, 2);
  // Existing per-char state preserved on the kept char (raid completion).
  const stored = docs.get("user-1");
  const persistedAlpha = stored.accounts[0].characters.find((c) => c.name === "Alpha");
  assert.equal(persistedAlpha.id, "char-alpha-id"); // id preserved
  assert.equal(persistedAlpha.assignedRaids.kazeros.G1.completedDate, 111);
  assert.equal(persistedAlpha.bibleSerial, "serial-alpha");
  assert.equal(persistedAlpha.bibleCid, "cid-alpha");
  assert.equal(persistedAlpha.bibleRid, "rid-alpha");
  assert.equal(persistedAlpha.publicLogDisabled, true);
  // Bible-side fields refreshed.
  assert.equal(persistedAlpha.itemLevel, 1705);
});

test("persistSelectedRoster: race-safe guard throws RACE_DUP_ROSTER when another account already covers this bible roster", async () => {
  const { factory, docs } = makeFactory();
  // Concurrent /add-roster session committed first under accountName "Alpha"
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

test("persistSelectedRoster: race guard does NOT false-positive on the legitimate target account", async () => {
  // When the user re-runs /add-roster on an EXISTING roster (same seed,
  // same chars), the matched account IS the merge target. The race guard
  // must skip it explicitly — overlap there is by design.
  const { factory, docs } = makeFactory();
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

  const session = makeSession({
    seedCharName: "Alpha",
    bibleNames: ["alpha", "beta"],
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    { charName: "Beta", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];

  const saved = await factory.__test.persistSelectedRoster(session, selected);
  assert.equal(saved.accountName, "Alpha");
  assert.equal(saved.characters.length, 2);
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

test("persistSelectedRoster: skips overlap check when bibleNames is empty (defensive default)", async () => {
  // bibleNames = empty Set means "no payload to compare against, skip
  // race guard entirely". Used as a defensive fallback if a future
  // caller forgets to populate it. Should NOT block anything.
  const { factory, docs } = makeFactory();
  docs.set("user-1", { discordId: "user-1", accounts: [] });

  const session = makeSession({
    seedCharName: "Alpha",
    bibleNames: [], // empty
  });
  const selected = [
    { charName: "Alpha", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ];

  const saved = await factory.__test.persistSelectedRoster(session, selected);
  assert.equal(saved.accountName, "Alpha");
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

test("persistSelectedRoster: matches existing account when selection chars overlap saved chars (different seed)", async () => {
  // Edge case: user had previously saved [Alpha, Beta] under accountName
  // "Alpha". They now run /add-roster with seed "Charlie" but the bible
  // roster they see is the SAME one (Alpha's roster), so their selection
  // includes Alpha or Beta. The account-match logic should still find
  // account "Alpha" via the chars-in-selection rule and merge into it.
  // (This case actually triggers the pre-fetch guard in the real
  // handler — but persistSelectedRoster's account-match must remain
  // correct on its own, so test here.)
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

  const saved = await factory.__test.persistSelectedRoster(session, selected);

  // Should merge into "Alpha" account, NOT create a new "Charlie" account.
  assert.equal(saved.accountName, "Alpha");
  assert.equal(saved.characters.length, 2);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 1, "should remain 1 account, not split");

  const persistedAlpha = stored.accounts[0].characters.find((c) => c.name === "Alpha");
  assert.equal(persistedAlpha.assignedRaids.kazeros.G1.completedDate, 999, "Alpha's raid completion preserved");
});

test("persistSelectedRoster: stamps registeredBy with callerId when actingForOther is true", async () => {
  // /add-roster target:U flow: Manager M acts on User U's behalf, so the
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
  // schema defaults - so we assert the field is unset/falsy rather than
  // strictly null. The persist code path must NOT be writing a string
  // here.
  assert.ok(
    stored.accounts[0].registeredBy === undefined ||
      stored.accounts[0].registeredBy === null,
    "self-add path must not stamp registeredBy"
  );
});

test("persistSelectedRoster: preserves existing registeredBy on merge into pre-stamped account", async () => {
  // Edge case: another /add-roster session (or a future re-register flow)
  // already created an account with `registeredBy = X`. Running this
  // helper against that account again must NOT overwrite the existing
  // stamp - the original helper Manager keeps their authorization.
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

  // Session simulates a different caller running /add-roster target:user-2
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

  await factory.__test.persistSelectedRoster(session, selected);

  const stored = docs.get("user-2");
  assert.equal(stored.accounts.length, 1, "should merge, not create new account");
  assert.equal(
    stored.accounts[0].registeredBy,
    "original-helper",
    "merge must preserve the original registeredBy stamp"
  );
});
