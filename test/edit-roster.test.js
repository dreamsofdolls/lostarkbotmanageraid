// Tests for /raid-edit-roster picker flow.
//
// Focus areas (each maps to a previously observed bug or load-bearing
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

const { createEditRosterCommand } = require("../bot/handlers/roster/edit");
const { createEditRosterRenderers } = require("../bot/handlers/roster/edit/edit-render");
const { UI, normalizeName, parseCombatScore, getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");
const { buildCharacterRecord, createCharacterId } = require("../bot/utils/raid/common/character");
const { clearUserLanguageCache, t } = require("../bot/services/i18n");
const { createBibleHttpError } = require("../bot/services/auto-manage/bible/rate-limit");

// Same in-memory User stub shape as add-roster.test.js. Kept duplicated
// (rather than shared via a helper) so each test file is self-contained
// and a future change to one's mock doesn't accidentally break the other.
function makeUserModel(events = null) {
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

test("handleEditRosterCommand defers ephemerally before its user lookup", async () => {
  clearUserLanguageCache();
  const events = [];
  const deferred = [];
  const { factory } = makeFactory({ events });
  const interaction = {
    user: { id: "fresh-edit-user" },
    options: {
      getString: () => "MissingRoster",
    },
    async deferReply(payload) {
      events.push("deferReply");
      deferred.push(payload);
    },
    async editReply() {
      events.push("editReply");
    },
  };

  await factory.handleEditRosterCommand(interaction);

  assert.deepEqual(events, [
    "deferReply",
    "findOne:fresh-edit-user",
    "editReply",
  ]);
  assert.equal(deferred[0].flags, MessageFlags.Ephemeral);
});

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

test("buildEditRosterPickerChars: tracks saved-overflow keys when savedCount > cap (legacy roster)", () => {
  // A legacy roster with more than the current cap of saved chars (for
  // example, 22 chars stored before the cap was tightened) gets sliced
  // to top 20. The 2 dropped saved chars must be exposed via
  // excludedSavedKeys so persistEditedRoster can preserve them as-is
  // instead of silently deleting them on Confirm.
  const { factory } = makeFactory();
  const savedChars = [];
  for (let i = 0; i < 22; i += 1) {
    savedChars.push({
      name: `Saved${String(i).padStart(2, "0")}`,
      class: "Bard",
      itemLevel: 1500 + i,
      combatScore: String(50000 + i * 100),
    });
  }
  const bibleChars = savedChars.map((c) => ({
    charName: c.name,
    className: c.class,
    itemLevel: c.itemLevel,
    combatScore: c.combatScore,
  }));

  const {
    displayChars,
    excludedBibleOnlyCount,
    excludedSavedCount,
    excludedSavedKeys,
  } = factory.__test.buildEditRosterPickerChars(savedChars, bibleChars, 20);

  assert.equal(displayChars.length, 20);
  assert.equal(excludedBibleOnlyCount, 0);
  assert.equal(excludedSavedCount, 2);
  assert.equal(excludedSavedKeys.size, 2);
  // Lowest-CP saved chars are the ones pushed off-window (sort puts
  // higher CP first within the saved tier).
  assert.equal(excludedSavedKeys.has("saved00"), true);
  assert.equal(excludedSavedKeys.has("saved01"), true);
});

test("persistEditedRoster: preserves off-window saved chars when picker capped (data-loss fix)", async () => {
  // The legacy-roster bug surface: 22 saved chars + cap 20. The picker
  // shows top 20 (by saved-first sort). User toggles off chars 5/10 and
  // Confirms. The 2 off-window chars (Saved00, Saved01 - lowest CP)
  // must SURVIVE Confirm even though they were never on the picker.
  const { factory, docs } = makeFactory();
  const characters = [];
  for (let i = 0; i < 22; i += 1) {
    characters.push({
      id: `id-${i}`,
      name: `Saved${String(i).padStart(2, "0")}`,
      class: "Bard",
      itemLevel: 1500 + i,
      combatScore: String(50000 + i * 100),
      assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
      tasks: [],
      sideTasks: [],
    });
  }
  // Stamp side-task on the off-window low-CP char to also pin sideTasks
  // preservation through the off-window code path.
  characters[0].sideTasks = [
    { taskId: "t1", name: "una", reset: "daily", completed: false, lastResetAt: 0, createdAt: 1 },
  ];
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{ accountName: "Alpha", characters }],
  });

  const preservedSavedKeys = new Set(["saved00", "saved01"]);
  const session = makeEditSession({ accountName: "Alpha" });
  session.preservedSavedKeys = preservedSavedKeys;

  // User confirms keeping all 20 displayed (Saved02..Saved21) plus
  // toggles off two of them as removals (Saved05, Saved10).
  const selected = [];
  for (let i = 21; i >= 2; i -= 1) {
    if (i === 5 || i === 10) continue;
    selected.push({
      charName: `Saved${String(i).padStart(2, "0")}`,
      className: "Bard",
      itemLevel: 1500 + i,
      combatScore: String(50000 + i * 100),
    });
  }

  const summary = await factory.__test.persistEditedRoster(session, selected);

  // Off-window keys are NOT counted as removed even though they aren't
  // in selectedChars.
  assert.deepEqual(summary.removed.map((character) => character.name).sort(), ["Saved05", "Saved10"]);

  const stored = docs.get("user-1");
  const finalNames = stored.accounts[0].characters.map((c) => c.name).sort();
  // Saved00 + Saved01 survive at the head, plus the 18 selected.
  assert.equal(finalNames.length, 20);
  assert.equal(finalNames.includes("Saved00"), true);
  assert.equal(finalNames.includes("Saved01"), true);
  assert.equal(finalNames.includes("Saved05"), false);
  assert.equal(finalNames.includes("Saved10"), false);
  // Off-window char's sideTasks survive intact.
  const saved00 = stored.accounts[0].characters.find((c) => c.name === "Saved00");
  assert.equal(saved00.sideTasks.length, 1);
  assert.equal(saved00.sideTasks[0].taskId, "t1");
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
  assert.equal(bibleError, t("raid-edit-roster.fallback.zeroOverlap", "vi"));
});

test("fetchBibleRosterWithFallback: empty savedChars skips overlap check (first success wins)", async () => {
  // Defensive: empty saved roster has no chars to compare against, so
  // the overlap check is moot. First successful fetch wins. (Real-world
  // path: account left empty by /raid-remove-roster.)
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

test("fetchBibleRosterWithFallback: a Bible 403 reads as its label, an unknown error stays in a code span", async () => {
  const savedChars = [{ name: "X", class: "Bard", itemLevel: 1700, combatScore: "85000" }];
  const blocked = makeFactory({
    fetchRosterCharacters: async () => {
      throw createBibleHttpError("LostArk Bible HTTP 403", { status: 403 });
    },
  });
  const unknown = makeFactory({
    fetchRosterCharacters: async (seed) => {
      throw new Error(`seed ${seed} failed`);
    },
  });

  const fromBlocked = await blocked.factory.__test.fetchBibleRosterWithFallback(savedChars, "Account", "en");
  const fromUnknown = await unknown.factory.__test.fetchBibleRosterWithFallback(savedChars, "Account", "en");

  assert.equal(fromBlocked.bibleError, t("common.bibleError.blocked", "en"));
  assert.equal(fromUnknown.bibleError, "`seed Account failed`");
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

  assert.deepEqual(summary.removed.map((character) => character.name).sort(), ["B", "C"]);
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

test("persistEditedRoster: preserves sideTasks on kept chars (HIGH bug fix)", async () => {
  // The Confirm path previously used a character record that omitted
  // sideTasks, so any user with /raid-task
  // entries on a char would silently lose them on /raid-edit-roster Confirm
  // even when re-selecting that char. Pin the fix: sideTasks must
  // round-trip through persistEditedRoster intact.
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
            assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
            tasks: [],
            sideTasks: [
              {
                taskId: "side-1",
                name: "Una daily",
                reset: "daily",
                completed: true,
                lastResetAt: 1700000000000,
                createdAt: 1690000000000,
              },
              {
                taskId: "side-2",
                name: "Guardian weekly",
                reset: "weekly",
                completed: false,
                lastResetAt: 1700000000000,
                createdAt: 1690000000000,
              },
            ],
          },
        ],
      },
    ],
  });

  const session = makeEditSession({ accountName: "Alpha" });
  // Confirm with A unchanged - the bug surfaces here because Confirm
  // rebuilds the char record from scratch even when nothing edits.
  const selected = [
    { charName: "A", className: "Bard", itemLevel: 1700, combatScore: "85000" },
  ];

  await factory.__test.persistEditedRoster(session, selected);

  const stored = docs.get("user-1");
  const a = stored.accounts[0].characters[0];
  assert.equal(Array.isArray(a.sideTasks), true);
  assert.equal(a.sideTasks.length, 2);
  const byId = Object.fromEntries(a.sideTasks.map((t) => [t.taskId, t]));
  assert.equal(byId["side-1"].name, "Una daily");
  assert.equal(byId["side-1"].reset, "daily");
  assert.equal(byId["side-1"].completed, true);
  assert.equal(byId["side-1"].lastResetAt, 1700000000000);
  assert.equal(byId["side-2"].name, "Guardian weekly");
  assert.equal(byId["side-2"].reset, "weekly");
  assert.equal(byId["side-2"].completed, false);
});

test("persistEditedRoster: throws when account vanished between command and Confirm", async () => {
  // Mid-session, user (or another concurrent flow) removed the account
  // via /raid-remove-roster. Confirm should return an explicit conflict so the
  // handler can render a localized conflict error.
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

  // A coded error, so the handler shows the localized not-found notice
  // rather than a hardcoded message inside the persist-failure card.
  await assert.rejects(
    () => factory.__test.persistEditedRoster(session, selected),
    { code: "ROSTER_NOT_FOUND" }
  );
});

test("edit-roster Confirm on a roster removed meanwhile shows the expired roster-changed notice in the user's language", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{ accountName: "Bravo", characters: [] }],
  });
  factory.__test.sessions.set("edit-sess-gone", {
    ...makeEditSession({ accountName: "Alpha" }),
    sessionId: "edit-sess-gone",
    lang: "en",
    chars: [{ charName: "X", className: "Bard", itemLevel: 1700, combatScore: "85000" }],
    selectedIndices: new Set([0]),
  });
  const edits = [];
  await factory.handleEditRosterButton({
    user: { id: "user-1" },
    customId: "edit-roster:confirm:edit-sess-gone",
    deferUpdate: async () => {},
    reply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  const embed = edits.at(-1).embeds[0].toJSON();
  assert.equal(
    embed.title,
    `⌛  ${t("raid-edit-roster.notice.goneTitle", "en", { rosterIcon: "❓", rosterName: "Alpha" })}`
  );
  assert.doesNotMatch(embed.description, /không còn tồn tại/);
});

test("edit not-found notice shows the question mark", async () => {
  clearUserLanguageCache();
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{ accountName: "Perfectwings", characters: [] }],
  });
  const edits = [];

  await factory.handleEditRosterCommand({
    user: { id: "user-1" },
    options: { getString: () => "Perfectwing" },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  const embed = edits[0].embeds[0].toJSON();
  assert.ok(embed.title.endsWith("Không thấy roster · ❓ Perfectwing"), embed.title);
});

test("Bible warning line reads one stop after each fallback reason", () => {
  for (const lang of ["vi", "en", "jp"]) {
    for (const key of ["noSeed", "noResults", "zeroOverlap"]) {
      const line = t("raid-edit-roster.picker.bibleOffline", lang, {
        iconWarn: "⚠️",
        error: t(`raid-edit-roster.fallback.${key}`, lang),
      });
      assert.doesNotMatch(line, /\.\.|。。|。\./, `${lang} ${key}: ${line}`);
    }
  }
});

test("edit not-found notice clips a very long roster name instead of failing", async () => {
  clearUserLanguageCache();
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{ accountName: "Perfectwings", characters: [] }],
  });
  const edits = [];

  await factory.handleEditRosterCommand({
    user: { id: "user-1" },
    options: { getString: () => "x".repeat(300) },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  assert.equal(edits.length, 1);
  assert.ok(edits[0].embeds[0].toJSON().title.length <= 256);
});

test("edit picker counts saved characters past the cap, with their roles", async () => {
  clearUserLanguageCache();
  const { factory, docs } = makeFactory({
    fetchRosterCharacters: async () => { throw new TypeError("fetch failed"); },
  });
  // 23 saved characters, 10 of them support: 3 sit past the 20-option cap.
  const characters = Array.from({ length: 23 }, (_, index) => ({
    id: `c${index}`,
    name: `Char${index}`,
    class: index >= 13 ? "Bard" : "Berserker",
    itemLevel: 1700,
    combatScore: String(90000 - index),
    assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
    tasks: [],
  }));
  docs.set("user-1", { discordId: "user-1", accounts: [{ accountName: "Char0", characters }] });
  const edits = [];

  await factory.handleEditRosterCommand({
    user: { id: "user-1" },
    options: { getString: () => "Char0" },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });
  for (const session of factory.__test.sessions.values()) clearTimeout(session.expireTimer);

  const summary = edits[0].embeds[0].toJSON().description.split("\n")[0];
  assert.equal(summary, "Lưu xong còn **23** char · 🛡️ 10 · ⚔️ 13");
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

test("fetchBibleRosterWithFallback: a saved name that differs from Bible's only by accents still overlaps", async () => {
  // The automatic roster refresh already folds accents when it checks
  // overlap (services/roster/refresh.js); /raid-edit-roster must agree, or
  // it reports "zero overlap" for a roster the refresh updates fine.
  const { factory } = makeFactory({
    fetchRosterCharacters: async () => [
      { charName: "Élise", className: "Bard", itemLevel: 1700, combatScore: "85000" },
    ],
  });

  const { bibleChars, bibleError } = await factory.__test.fetchBibleRosterWithFallback(
    [{ name: "Elise", class: "Bard", itemLevel: 1700, combatScore: "85000" }],
    "Elise"
  );

  assert.equal(bibleError, null);
  assert.equal(bibleChars.length, 1);
});

// --------- characters renamed in game ---------
// lostark.bible keeps a character's id (`cid`) through a rename. A saved
// character whose name left the roster and a roster name nobody saved, with
// the same id, are one character: the picker shows it once, kept, under the
// new name, and Save renames the saved record instead of replacing it.

test("buildEditRosterPickerChars: a character renamed in game is one kept row under its new name", () => {
  const { factory } = makeFactory();
  const { merged } = factory.__test.buildEditRosterPickerChars(
    [
      { name: "Chixpaul", class: "Wildsoul", itemLevel: 1750, combatScore: "4000", bibleCid: 106427776 },
      { name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 },
    ],
    [
      { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, combatScore: "4000", cid: 106427776 },
      { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 },
    ],
    25
  );

  assert.equal(merged.length, 2);
  const renamed = merged.find((c) => c.savedKey === "zedaxpaul");
  assert.equal(renamed.charName, "Sunxpaul");
  assert.equal(renamed.itemLevel, 1781.67);
  assert.equal(renamed.inBible, true);
});

test("buildEditRosterPickerChars: a saved character with no bible character id stays apart from a new name", () => {
  const { factory } = makeFactory();
  const { merged } = factory.__test.buildEditRosterPickerChars(
    [{ name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000" }],
    [{ charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 }],
    25
  );

  assert.deepEqual(
    merged.map((c) => [c.charName, c.savedKey, c.inBible]),
    [["Zedaxpaul", "zedaxpaul", false], ["Sunxpaul", null, true]]
  );
});

test("buildEditRosterPickerChars: a new name the user already saved keeps its own row", () => {
  const { factory } = makeFactory();
  const { merged } = factory.__test.buildEditRosterPickerChars(
    [
      { name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 },
      { name: "Sunxpaul", class: "Souleater", itemLevel: 1781.67, combatScore: "7139.95" },
    ],
    [{ charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 }],
    25
  );

  assert.deepEqual(
    merged.map((c) => [c.charName, c.savedKey]).sort(),
    [["Sunxpaul", "sunxpaul"], ["Zedaxpaul", "zedaxpaul"]]
  );
});

test("buildEditRosterPickerChars: two saved characters with one bible id pair only the first", () => {
  const { factory } = makeFactory();
  const { merged } = factory.__test.buildEditRosterPickerChars(
    [
      { name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 },
      { name: "Zedaxpaul2", class: "Souleater", itemLevel: 1750, combatScore: "5000", bibleCid: 291570 },
    ],
    [{ charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 }],
    25
  );

  assert.deepEqual(
    merged.map((c) => [c.charName, c.savedKey]),
    [["Sunxpaul", "zedaxpaul"], ["Zedaxpaul2", "zedaxpaul2"]]
  );
});

test("/raid-edit-roster opens a renamed character as one kept row under its new name", async () => {
  clearUserLanguageCache();
  const { factory, docs } = makeFactory({
    fetchRosterCharacters: async () => [
      { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, combatScore: "4000", cid: 106427776 },
      { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 },
    ],
  });
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Chixpaul",
      characters: [
        { id: "chix-id", name: "Chixpaul", class: "Wildsoul", itemLevel: 1750, combatScore: "4000", bibleCid: 106427776 },
        { id: "zed-id", name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 },
      ],
    }],
  });

  await factory.handleEditRosterCommand({
    user: { id: "user-1" },
    options: { getString: () => "Chixpaul" },
    deferReply: async () => {},
    editReply: async () => {},
  });
  const [session] = factory.__test.sessions.values();
  for (const open of factory.__test.sessions.values()) clearTimeout(open.expireTimer);

  assert.deepEqual(
    session.chars.map((c) => [c.charName, c.savedKey]),
    [["Sunxpaul", "zedaxpaul"], ["Chixpaul", "chixpaul"]]
  );
  assert.equal(session.selectedIndices.size, 2);
});

function pickerText(embed) {
  const json = embed.toJSON();
  return [json.description, ...(json.fields || []).map((field) => field.value)].join("\n");
}

test("the picker marks a renamed character with its old name and leaves the others as kept", async () => {
  clearUserLanguageCache();
  const { factory, docs } = makeFactory({
    fetchRosterCharacters: async () => [
      { charName: "Chixpaul", className: "Wildsoul", itemLevel: 1750, combatScore: "4000", cid: 106427776 },
      { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", cid: 291570 },
    ],
  });
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Chixpaul",
      characters: [
        { id: "chix-id", name: "Chixpaul", class: "Wildsoul", itemLevel: 1750, combatScore: "4000", bibleCid: 106427776 },
        { id: "zed-id", name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 },
      ],
    }],
  });
  const edits = [];

  await factory.handleEditRosterCommand({
    user: { id: "user-1" },
    options: { getString: () => "Chixpaul" },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });
  const [session] = factory.__test.sessions.values();
  for (const open of factory.__test.sessions.values()) clearTimeout(open.expireTimer);

  assert.equal(session.chars[0].renamedFrom, "Zedaxpaul");
  assert.equal(session.chars[1].renamedFrom ?? null, null);
  const text = pickerText(edits[0].embeds[0]);
  assert.match(text, /🔁 \*\*1\.\*\* .*\*\*Sunxpaul\*\*.*đổi tên từ Zedaxpaul/u);
  assert.match(text, /✅ \*\*2\.\*\* .*\*\*Chixpaul\*\*/u);
  assert.doesNotMatch(text, /Chixpaul.*đổi tên từ/u);
  const options = edits[0].components
    .map((row) => row.toJSON())
    .flatMap((row) => row.components)
    .flatMap((component) => component.options || []);
  assert.equal(options[0].label, "1. Sunxpaul 🔁");
  assert.match(options[0].description, /^🔁/u);
});

test("a renamed character the user unticks reads as a removal, like any saved character", () => {
  const { buildSelectionEmbed } = createEditRosterRenderers({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UI, pickerMaxOptions: 20,
  });
  const session = {
    ...makeEditSession({ accountName: "Chixpaul" }),
    lang: "vi",
    preservedSavedClasses: [],
    expiresAt: Date.now() + 60000,
    chars: [{
      charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95",
      savedKey: "zedaxpaul", inBible: true, renamedFrom: "Zedaxpaul",
    }],
    selectedIndices: new Set(),
  };

  const text = pickerText(buildSelectionEmbed(session));

  assert.match(text, /➖ \*\*1\.\*\* .*~~Sunxpaul~~.*sẽ bỏ/u);
  assert.doesNotMatch(text, /🔁|đổi tên từ/u);
});

test("persistEditedRoster: a renamed row leaves a rename note that a later edit keeps", async () => {
  const before = Date.now();
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Chixpaul",
      characters: [{ id: "zed-id", name: "Zedaxpaul", class: "Souleater", itemLevel: 1750, combatScore: "6000", bibleCid: 291570 }],
    }],
  });
  const session = makeEditSession({ accountName: "Chixpaul" });

  await factory.__test.persistEditedRoster(session, [
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", savedKey: "zedaxpaul", inBible: true },
  ]);
  const [renamed] = docs.get("user-1").accounts[0].characters;
  assert.equal(renamed.renamedFrom, "Zedaxpaul");
  assert.ok(renamed.renamedAt >= before);

  await factory.__test.persistEditedRoster(session, [
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1782, combatScore: "7200", savedKey: "sunxpaul", inBible: true },
  ]);
  const [edited] = docs.get("user-1").accounts[0].characters;
  assert.equal(edited.renamedFrom, "Zedaxpaul");
  assert.equal(edited.renamedAt, renamed.renamedAt);
});

test("persistEditedRoster: a renamed row keeps the saved character and its progress under the new name", async () => {
  const { factory, docs } = makeFactory();
  docs.set("user-1", {
    discordId: "user-1",
    accounts: [{
      accountName: "Chixpaul",
      characters: [{
        id: "zed-id",
        name: "Zedaxpaul",
        class: "Souleater",
        itemLevel: 1750,
        combatScore: "6000",
        isGoldEarner: false,
        bibleSerial: "200000067680670",
        bibleCid: 291570,
        bibleRid: 211957,
        assignedRaids: { serca: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 111 } } },
        sideTasks: [{ taskId: "una", name: "Una dailies", reset: "daily", completed: true }],
      }],
    }],
  });

  const summary = await factory.__test.persistEditedRoster(makeEditSession({ accountName: "Chixpaul" }), [
    { charName: "Sunxpaul", className: "Souleater", itemLevel: 1781.67, combatScore: "7139.95", savedKey: "zedaxpaul", inBible: true },
  ]);

  const [stored] = docs.get("user-1").accounts[0].characters;
  assert.equal(docs.get("user-1").accounts[0].characters.length, 1);
  assert.equal(stored.name, "Sunxpaul");
  assert.equal(stored.itemLevel, 1781.67);
  assert.equal(stored.id, "zed-id");
  assert.equal(stored.isGoldEarner, false);
  assert.equal(stored.bibleSerial, "200000067680670");
  assert.equal(stored.bibleCid, 291570);
  assert.equal(stored.assignedRaids.serca.G1.completedDate, 111);
  assert.equal(stored.sideTasks.length, 1);
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(summary.added, []);
  assert.deepEqual(summary.kept, ["Sunxpaul"]);
});
