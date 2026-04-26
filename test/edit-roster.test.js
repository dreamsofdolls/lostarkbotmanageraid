// Tests for /edit-roster picker flow.
//
// Focus areas (each maps to a Codex-flagged bug or load-bearing
// invariant):
//   1. fetchBibleRosterWithFallback: multi-seed retry + zero-overlap reject
//   2. buildEditRosterPickerChars: saved-first sort so truncation never
//      drops a saved char (the high-severity "silent delete" bug)
//   3. persistEditedRoster: diff-apply preserves per-char state
//   4. persistEditedRoster: throws when the target account vanished
//      between command and Confirm

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

const { createEditRosterCommand } = require("../src/commands/edit-roster");
const { UI, normalizeName, parseCombatScore, getCharacterName, getCharacterClass } = require("../src/raid/shared");
const { buildCharacterRecord, createCharacterId } = require("../src/raid/character");

// Same in-memory User stub shape as add-roster.test.js. Kept duplicated
// (rather than shared via a helper) so each test file is self-contained
// and a future change to one's mock doesn't accidentally break the other.
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
  const factory = createEditRosterCommand({
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
    loadUserForAutocomplete: async () => null,
  });
  return { factory, User, docs };
}

// --------- buildEditRosterPickerChars (saved-first sort + truncation) ---------

test("buildEditRosterPickerChars: saved chars sort first even when bible chars have higher CP", () => {
  // The high-severity bug: with sort-by-CP-only, a saved char with low
  // CP could be bumped out of the top-25 window by a new high-CP bible
  // char. With saved-first ordering, every saved char must appear in
  // the displayed list ahead of any bible-only char.
  const { factory } = makeFactory();
  const savedChars = [
    { name: "LowCpSaved", class: "Bard", itemLevel: 1620, combatScore: "70000" },
  ];
  const bibleChars = [
    { charName: "LowCpSaved", className: "Bard", itemLevel: 1620, combatScore: "70000" },
    { charName: "HighCpNew", className: "Berserker", itemLevel: 1740, combatScore: "95000" },
    { charName: "MidCpNew", className: "Paladin", itemLevel: 1700, combatScore: "85000" },
  ];

  const { displayChars } = factory.__test.buildEditRosterPickerChars(savedChars, bibleChars, 25);

  // Saved-first invariant: LowCpSaved must precede every bible-only char
  // despite being the lowest-CP overall.
  assert.equal(displayChars[0].charName, "LowCpSaved");
  assert.equal(displayChars[0].savedKey !== null, true);
  assert.equal(displayChars[1].charName, "HighCpNew");
  assert.equal(displayChars[1].savedKey, null);
  assert.equal(displayChars[2].charName, "MidCpNew");
});

test("buildEditRosterPickerChars: saved chars never excluded by truncation when savedCount ≤ cap", () => {
  // Worst case: 25 saved chars + 5 bible-only new chars with higher CP.
  // Truncation to 25 must keep ALL saved chars and drop the bible-only
  // overflow. Otherwise Confirm would silently delete the dropped saved
  // chars on the next run.
  const { factory } = makeFactory();
  const savedChars = [];
  for (let i = 0; i < 25; i += 1) {
    savedChars.push({
      name: `Saved${i}`,
      class: "Bard",
      itemLevel: 1500 + i, // ascending, so CP-sort would scatter
      combatScore: String(50000 + i * 100),
    });
  }
  const bibleChars = savedChars.map((c) => ({
    charName: c.name,
    className: c.class,
    itemLevel: c.itemLevel,
    combatScore: c.combatScore,
  }));
  // Add 5 high-CP new bible chars
  for (let i = 0; i < 5; i += 1) {
    bibleChars.push({
      charName: `New${i}`,
      className: "Berserker",
      itemLevel: 1740,
      combatScore: "99000",
    });
  }

  const { displayChars, excludedBibleOnlyCount } = factory.__test.buildEditRosterPickerChars(
    savedChars,
    bibleChars,
    25
  );

  assert.equal(displayChars.length, 25);
  assert.equal(excludedBibleOnlyCount, 5);
  // Every displayed char is saved (none are bible-only).
  const savedDisplayedCount = displayChars.filter((c) => c.savedKey !== null).length;
  assert.equal(savedDisplayedCount, 25);
});

test("buildEditRosterPickerChars: surfaces bible-only chars in remaining slots when room exists", () => {
  // 3 saved + 5 bible-only → 25-cap leaves 22 free slots → all 5
  // bible-only fit, 0 excluded.
  const { factory } = makeFactory();
  const savedChars = ["A", "B", "C"].map((n) => ({
    name: n, class: "Bard", itemLevel: 1700, combatScore: "85000",
  }));
  const bibleChars = [...savedChars.map((c) => ({ charName: c.name, className: c.class, itemLevel: c.itemLevel, combatScore: c.combatScore }))];
  for (let i = 0; i < 5; i += 1) {
    bibleChars.push({ charName: `New${i}`, className: "Paladin", itemLevel: 1690, combatScore: "82000" });
  }

  const { displayChars, excludedBibleOnlyCount } = factory.__test.buildEditRosterPickerChars(
    savedChars,
    bibleChars,
    25
  );

  assert.equal(displayChars.length, 8);
  assert.equal(excludedBibleOnlyCount, 0);
});

test("buildEditRosterPickerChars: tags entries with savedKey and inBible correctly", () => {
  const { factory } = makeFactory();
  const savedChars = [
    { name: "BothA", class: "Bard", itemLevel: 1700, combatScore: "85000" },
    { name: "SavedOnly", class: "Paladin", itemLevel: 1690, combatScore: "82000" }, // not in bible (rename / private log)
  ];
  const bibleChars = [
    { charName: "BothA", className: "Bard", itemLevel: 1705, combatScore: "86000" },
    { charName: "BibleOnly", className: "Berserker", itemLevel: 1680, combatScore: "80000" },
  ];

  const { merged } = factory.__test.buildEditRosterPickerChars(savedChars, bibleChars, 25);
  const byName = Object.fromEntries(merged.map((c) => [c.charName, c]));

  assert.equal(byName.BothA.savedKey !== null, true);
  assert.equal(byName.BothA.inBible, true);
  assert.equal(byName.SavedOnly.savedKey !== null, true);
  assert.equal(byName.SavedOnly.inBible, false);
  assert.equal(byName.BibleOnly.savedKey, null);
  assert.equal(byName.BibleOnly.inBible, true);
});

test("buildEditRosterPickerChars: prefers bible-side fields (iLvl/CP/class) when both sources have the char", () => {
  const { factory } = makeFactory();
  const savedChars = [{ name: "X", class: "OldClass", itemLevel: 1600, combatScore: "60000" }];
  const bibleChars = [{ charName: "X", className: "NewClass", itemLevel: 1700, combatScore: "85000" }];

  const { displayChars } = factory.__test.buildEditRosterPickerChars(savedChars, bibleChars, 25);
  assert.equal(displayChars[0].className, "NewClass");
  assert.equal(displayChars[0].itemLevel, 1700);
  assert.equal(displayChars[0].combatScore, "85000");
});

// --------- fetchBibleRosterWithFallback (multi-seed + overlap reject) ---------

test("fetchBibleRosterWithFallback: first seed succeeds with overlap → returns immediately", async () => {
  let calls = 0;
  const { factory } = makeFactory({
    fetchRosterCharacters: async (seed) => {
      calls += 1;
      assert.equal(seed, "HighCpChar", "should try highest-CP saved char first");
      return [
        { charName: "HighCpChar", className: "Bard", itemLevel: 1700, combatScore: "85000" },
        { charName: "OtherChar", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
      ];
    },
  });

  const savedChars = [
    { name: "HighCpChar", class: "Bard", itemLevel: 1700, combatScore: "85000" },
    { name: "LowCpChar", class: "Paladin", itemLevel: 1600, combatScore: "70000" },
  ];

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    savedChars,
    "HighCpChar"
  );

  assert.equal(calls, 1, "should not try further seeds after first success");
  assert.equal(bibleError, null);
  assert.equal(bibleChars.length, 2);
});

test("fetchBibleRosterWithFallback: skips zero-overlap result, tries next seed", async () => {
  // First seed (HighCpChar) returns a roster with no overlap with saved
  // (signal: in-game rename, bible returned wrong roster). Should skip
  // and try LowCpChar next, which returns the right roster.
  let calls = 0;
  const seedsTried = [];
  const { factory } = makeFactory({
    fetchRosterCharacters: async (seed) => {
      calls += 1;
      seedsTried.push(seed);
      if (seed === "HighCpChar") {
        // zero-overlap: returns a totally different roster
        return [
          { charName: "Stranger1", className: "Bard", itemLevel: 1700, combatScore: "85000" },
          { charName: "Stranger2", className: "Paladin", itemLevel: 1690, combatScore: "82000" },
        ];
      }
      // LowCpChar's seed returns the correct roster (overlap with saved)
      return [
        { charName: "HighCpChar", className: "Bard", itemLevel: 1700, combatScore: "85000" },
        { charName: "LowCpChar", className: "Paladin", itemLevel: 1600, combatScore: "70000" },
      ];
    },
  });

  const savedChars = [
    { name: "HighCpChar", class: "Bard", itemLevel: 1700, combatScore: "85000" },
    { name: "LowCpChar", class: "Paladin", itemLevel: 1600, combatScore: "70000" },
  ];

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    savedChars,
    "AccountAlias"
  );

  assert.equal(calls, 2);
  assert.deepEqual(seedsTried, ["HighCpChar", "LowCpChar"]);
  assert.equal(bibleError, null);
  assert.equal(bibleChars.length, 2);
  assert.equal(bibleChars.find((c) => c.charName === "HighCpChar")?.charName, "HighCpChar");
});

test("fetchBibleRosterWithFallback: all seeds zero-overlap → bibleError set", async () => {
  // Worst case: every seed returns a stranger's roster. Refuse to merge
  // any of them — set bibleError so the picker falls back to remove-only
  // mode.
  const { factory } = makeFactory({
    fetchRosterCharacters: async () => [
      { charName: "Stranger", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    ],
  });

  const savedChars = [
    { name: "MyChar1", class: "Bard", itemLevel: 1700, combatScore: "85000" },
    { name: "MyChar2", class: "Paladin", itemLevel: 1690, combatScore: "82000" },
  ];

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    savedChars,
    "AccountAlias"
  );

  assert.equal(bibleChars.length, 0);
  assert.match(bibleError, /không trùng saved chars|rename/i);
});

test("fetchBibleRosterWithFallback: empty savedChars skips overlap check (first success wins)", async () => {
  // Defensive: empty saved roster has no chars to compare against, so
  // the overlap check is moot. First successful fetch wins. (Real-world
  // path: account left empty by /remove-roster.)
  let calls = 0;
  const { factory } = makeFactory({
    fetchRosterCharacters: async () => {
      calls += 1;
      return [{ charName: "AnyChar", className: "Bard", itemLevel: 1700, combatScore: "85000" }];
    },
  });

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    [], // empty saved
    "AccountAlias"
  );

  assert.equal(calls, 1);
  assert.equal(bibleError, null);
  assert.equal(bibleChars[0].charName, "AnyChar");
});

test("fetchBibleRosterWithFallback: all seeds throw → bibleError = lastError", async () => {
  const { factory } = makeFactory({
    fetchRosterCharacters: async (seed) => {
      throw new Error(`seed ${seed} failed`);
    },
  });

  const savedChars = [{ name: "X", class: "Bard", itemLevel: 1700, combatScore: "85000" }];
  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    savedChars,
    "Account"
  );

  assert.equal(bibleChars.length, 0);
  assert.match(bibleError, /seed .+ failed/);
});

test("fetchBibleRosterWithFallback: empty seeds list → bibleError 'không có seed'", async () => {
  // No saved chars + no accountName means no seeds at all to try.
  const { factory } = makeFactory({
    fetchRosterCharacters: async () => {
      throw new Error("should not be called");
    },
  });

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback([], "");

  assert.equal(bibleChars.length, 0);
  assert.match(bibleError, /Không có seed/);
});

// --------- persistEditedRoster (diff-apply + state preservation) ---------

function makeEditSession({ accountName = "Alpha" } = {}) {
  return {
    sessionId: "edit-sess-test",
    callerId: "user-1",
    discordId: "user-1",
    accountName,
    bibleError: null,
    excludedBibleOnlyCount: 0,
    chars: [],
    selectedIndices: new Set(),
    expireTimer: null,
  };
}

test("persistEditedRoster: removes unticked chars, keeps ticked ones", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { id: "a-id", name: "A", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
          { id: "b-id", name: "B", class: "Paladin", itemLevel: 1690, combatScore: "82000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
          { id: "c-id", name: "C", class: "Berserker", itemLevel: 1680, combatScore: "80000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
        ],
      },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" });
  const selected = [
    { charName: "A", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    // B and C unticked - should be removed
  ];

  const summary = await factory.__test.persistEditedRoster(session, selected);

  assert.deepEqual(summary.removed.sort(), ["B", "C"]);
  assert.deepEqual(summary.kept, ["A"]);
  assert.deepEqual(summary.added, []);

  const stored = docs.get("user-1");
  assert.deepEqual(stored.accounts[0].characters.map((c) => c.name), ["A"]);
});

test("persistEditedRoster: adds new chars from selection that weren't saved before", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { id: "a-id", name: "A", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
        ],
      },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" });
  const selected = [
    { charName: "A", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    { charName: "B", className: "Paladin", itemLevel: 1690, combatScore: "82000" }, // new
  ];

  const summary = await factory.__test.persistEditedRoster(session, selected);

  assert.deepEqual(summary.added, ["B"]);
  assert.deepEqual(summary.kept, ["A"]);
  assert.deepEqual(summary.removed, []);

  const stored = docs.get("user-1");
  assert.deepEqual(stored.accounts[0].characters.map((c) => c.name).sort(), ["A", "B"]);
});

test("persistEditedRoster: preserves per-char state (raid completion, bibleSerial) on kept chars", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          {
            id: "a-id",
            name: "A",
            class: "Bard",
            itemLevel: 1700,
            combatScore: "85000",
            bibleSerial: "serial-123",
            bibleCid: 42,
            bibleRid: 99,
            publicLogDisabled: true,
            assignedRaids: {
              armoche: {},
              kazeros: { G1: { difficulty: "Hard", completedDate: 111 } },
              serca: {},
            },
            tasks: [{ id: "task-1", completions: 3, completionDate: 222 }],
          },
        ],
      },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" });
  // Re-select A with refreshed bible-side fields (higher iLvl).
  const selected = [
    { charName: "A", className: "Bard", itemLevel: 1710, combatScore: "87000" },
  ];

  await factory.__test.persistEditedRoster(session, selected);

  const stored = docs.get("user-1");
  const a = stored.accounts[0].characters[0];
  // Bible-side fields refreshed
  assert.equal(a.itemLevel, 1710);
  assert.equal(a.combatScore, "87000");
  // Per-char state preserved
  assert.equal(a.id, "a-id");
  assert.equal(a.bibleSerial, "serial-123");
  assert.equal(a.bibleCid, 42);
  assert.equal(a.bibleRid, 99);
  assert.equal(a.publicLogDisabled, true);
  assert.equal(a.assignedRaids.kazeros.G1.completedDate, 111);
  assert.equal(a.tasks[0].completions, 3);
  assert.equal(a.tasks[0].completionDate, 222);
});

test("persistEditedRoster: throws when account vanished between command and Confirm", async () => {
  // Mid-session, user (or another concurrent flow) removed the account
  // via /remove-roster. Confirm should fail loudly so the Confirm
  // handler can render a friendly error.
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      // Note: NOT "Alpha" — different account name
      { accountName: "Bravo", characters: [] },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" }); // session was about Alpha
  const selected = [
    { charName: "X", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ];

  await assert.rejects(
    () => factory.__test.persistEditedRoster(session, selected),
    /không còn tồn tại/
  );
});

test("persistEditedRoster: throws when user doc disappeared entirely", async () => {
  const { factory } = makeFactory();
  // No user doc seeded at all.

  const session = makeEditSession({ accountName: "Alpha" });
  const selected = [
    { charName: "X", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ];

  await assert.rejects(
    () => factory.__test.persistEditedRoster(session, selected),
    /User document disappeared/
  );
});

test("persistEditedRoster: stamps account.lastRefreshedAt for /raid-status lazy-refresh skip", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        lastRefreshedAt: 1, // ancient
        characters: [
          { id: "a-id", name: "A", class: "Bard", itemLevel: 1700, combatScore: "85000", assignedRaids: { armoche: {}, kazeros: {}, serca: {} }, tasks: [] },
        ],
      },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" });
  const before = Date.now();
  await factory.__test.persistEditedRoster(session, [
    { charName: "A", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ]);
  const after = Date.now();

  const stored = docs.get("user-1");
  const stamp = stored.accounts[0].lastRefreshedAt;
  assert.ok(stamp >= before && stamp <= after, `expected lastRefreshedAt in [${before},${after}], got ${stamp}`);
});
