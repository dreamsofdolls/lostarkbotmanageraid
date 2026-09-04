const test = require("node:test");
const assert = require("node:assert/strict");

const { propagatePartyDeltas } = require("../bot/services/local-sync");
const User = require("../bot/models/user");

function makeCharacter(name, progress = null) {
  return {
    name,
    class: "Bard",
    itemLevel: 1750,
    assignedRaids: progress ? { armoche: progress } : {},
  };
}

function makeUser(discordId, characters, flags = {}) {
  return {
    discordId,
    localSyncEnabled: false,
    autoManageEnabled: false,
    ...flags,
    accounts: [{ accountName: `${discordId}-roster`, characters }],
  };
}

function makePartyDelta(charName) {
  return {
    boss: "Armoche, Sentinel of the Abyss",
    difficulty: "Hard",
    cleared: true,
    charName,
    sourceCharName: "Source",
    lastClearMs: 2_000,
  };
}

test("party roster lookup has a case-insensitive character-name index", () => {
  const [keys, options] = User.schema.indexes().find(([, indexOptions]) => (
    indexOptions.name === "sync_party_character_lookup"
  )) || [];

  assert.ok(options);
  assert.deepEqual(keys, { "accounts.characters.name": 1 });
  assert.deepEqual(options.collation, { locale: "en", strength: 2 });
});

test("party propagation enforces the 16-player Gate boundary before querying rosters", async () => {
  let queried = false;
  const UserModel = {
    find() {
      queried = true;
      throw new Error("roster query must not run for an oversized party");
    },
  };

  await assert.rejects(
    propagatePartyDeltas(
      Array.from({ length: 16 }, (_, index) => ({
        ...makePartyDelta(`Target${index}`),
        lastClearMs: 2_000 + index,
      })),
      { UserModel }
    ),
    /too many party targets for one source Gate \(max 15\)/
  );
  assert.equal(queried, false);
});

test("party propagation batches per owner, includes both sync modes, and ignores touched raids", async () => {
  const users = [
    makeUser("local-owner", [makeCharacter("Aki"), makeCharacter("Dara")], {
      localSyncEnabled: true,
    }),
    makeUser("auto-owner", [makeCharacter("Bao")], {
      autoManageEnabled: true,
    }),
    makeUser("progress-owner", [makeCharacter("Ciel", {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: 1_500 },
      G2: { difficulty: "Hard", completedDate: null },
    })], { localSyncEnabled: true }),
    // A stale query snapshot must still be harmless: preflight and the fresh
    // writer guard both receive requireAnySyncEnabled.
    makeUser("off-owner", [makeCharacter("Eira")]),
  ];
  const queryState = {};
  const UserModel = {
    find(filter) {
      queryState.filter = filter;
      return {
        select(value) {
          queryState.select = value;
          return this;
        },
        collation(value) {
          queryState.collation = value;
          return this;
        },
        async lean() {
          return users;
        },
      };
    },
  };
  const batchCalls = [];

  const result = await propagatePartyDeltas([
    makePartyDelta("Aki"),
    makePartyDelta("Bao"),
    makePartyDelta("Ciel"),
    makePartyDelta("Dara"),
    makePartyDelta("Eira"),
  ], {
    UserModel,
    currentWeekStartMs: 1_000,
    applyRaidSetForDiscordId: async () => {
      throw new Error("single writer should not run when batch writer is available");
    },
    applyRaidSetBatchForDiscordId: async (args) => {
      batchCalls.push(args);
      return args.entries.map((entry) => ({
        matched: true,
        updated: true,
        displayName: entry.characterName,
      }));
    },
  });

  assert.deepEqual(result.applied.map((entry) => entry.charName).sort(), ["Aki", "Bao", "Dara"]);
  assert.equal(result.applied.every((entry) => entry.propagated), true);
  assert.equal(result.ignored.some((entry) => (
    entry.charName === "Ciel" && entry.reason === "progress_already_started"
  )), true);
  assert.equal(result.ignored.some((entry) => (
    entry.charName === "Eira" && entry.reason === "sync_disabled"
  )), true);
  assert.equal(result.rejected.length, 0);
  assert.equal(batchCalls.length, 2, "two owners should produce two saves, not three character saves");
  assert.deepEqual(batchCalls.map((call) => call.entries.length).sort(), [1, 2]);
  assert.equal(batchCalls.every((call) => call.requireAnySyncEnabled === true), true);
  assert.equal(batchCalls.every((call) => call.requireRaidUntouched === true), true);
  assert.deepEqual(queryState.collation, { locale: "en", strength: 2 });
  assert.deepEqual(queryState.filter.$or, [
    { localSyncEnabled: true },
    { autoManageEnabled: true },
  ]);
});
