"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseGoldModeValues,
  saveBulkGoldReceive,
  saveBulkRaidModes,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const {
  ensureFreshWeek,
  getTargetResetKey,
} = require("../bot/services/raid/schedulers/weekly-reset");
const {
  getStatusRaidsForCharacter,
} = require("../bot/utils/raid/common/character");
const User = require("../bot/models/user");

function makeUserModel(doc) {
  return {
    async findOne() {
      return doc;
    },
  };
}

// Build a real Mongoose User document (not a plain mock) so the test exercises
// the strict:false assignedRaids subdoc serialization. A plain-object mock
// would let `subdoc.goldOverride = x` "work" and hide the persistence bug the
// live bot hit · the override field was being dropped on save because it was
// assigned straight onto a Mongoose subdoc instead of through a re-cast.
function makeMongooseUserDoc({
  accountName = "Roster",
  charName = "Aki",
  itemLevel = 1753,
  horizonModeKey = "nightmare",
  assignedRaids = null,
} = {}) {
  const defaultAssignedRaids = {
    armoche: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
    kazeros: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
    serca: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
    horizon: { modeKey: horizonModeKey },
  };
  const doc = new User({
    discordId: "user-1",
    weeklyResetKey: getTargetResetKey(),
    accounts: [
      {
        accountName,
        characters: [
          {
            id: "c1",
            name: charName,
            class: "Aeromancer",
            itemLevel,
            assignedRaids: assignedRaids || defaultAssignedRaids,
          },
        ],
      },
    ],
  });
  // Stub save() so no DB connection is needed; the assertions read toObject(),
  // which reflects exactly what save() would serialize.
  doc.save = async () => doc;
  return doc;
}

function horizonOverrideOf(doc) {
  return doc.toObject().accounts[0].characters[0].assignedRaids.horizon.goldOverride;
}

const WRITE_TARGET = {
  saveWithRetry: async (op) => op(),
  discordId: "user-1",
  targetAccountName: "Roster",
  targetCharNames: ["Aki"],
};

test("raid-status gold mode reads a legacy raid's current mode from its gate difficulty", async () => {
  // Legacy entry: no modeKey, G1 cleared at Normal, and the character is
  // high enough for Hard. The gold view shows it as Normal and offers Hard.
  const doc = makeMongooseUserDoc({
    itemLevel: 1735,
    assignedRaids: {
      kazeros: {
        G1: { difficulty: "Normal", completedDate: 99 },
        G2: { difficulty: "Normal" },
      },
    },
  });
  const shown = getStatusRaidsForCharacter(doc.accounts[0].characters[0])
    .find((raid) => raid.raidKey === "kazeros");
  assert.equal(shown.modeKey, "normal");

  const result = await saveBulkRaidModes({
    ...WRITE_TARGET,
    User: makeUserModel(doc),
    decisions: parseGoldModeValues(["kazeros::hard"]).decisions,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].outcomes[0].outcome, "deferred");
  const raid = doc.toObject().accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(raid.pendingModeKey, "hard");
  assert.equal(raid.G1.difficulty, "Normal");
});

test("raid-status gold override survives Mongoose subdoc serialization", async () => {
  // ilvl 1705 keeps only Act 4 (1700) and Horizon (1700) eligible. The
  // override must be present in the SERIALIZED doc, not just on the in-memory
  // subdoc wrapper; before the plain-object re-cast it read undefined.
  const doc = makeMongooseUserDoc({ itemLevel: 1705, horizonModeKey: "normal" });

  const result = await saveBulkGoldReceive({
    ...WRITE_TARGET,
    User: makeUserModel(doc),
    receive: { kind: "set", raidKeys: ["horizon"] },
  });

  assert.equal(result.ok, true);
  assert.equal(horizonOverrideOf(doc), "include");
});

test("a gold choice made after the weekly reset, before the user rolled over, survives the rollover", async (t) => {
  // The weekly reset job had not reached this user yet, so the stored cursor
  // is last week's; a choice written onto it would be cleared as old data.
  const afterReset = new Date("2026-10-14T10:01:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: afterReset.getTime() });
  const operations = {
    goldSet: (options) => saveBulkGoldReceive({ ...options, receive: { kind: "set", raidKeys: ["horizon"] } }),
    mode: (options) => saveBulkRaidModes({ ...options, decisions: parseGoldModeValues(["horizon::hard"]).decisions }),
  };
  const expectations = {
    goldSet: (doc) => assert.equal(horizonOverrideOf(doc), "include"),
    mode: (doc) => assert.equal(doc.toObject().accounts[0].characters[0].assignedRaids.horizon.modeKey, "hard"),
  };
  for (const [label, run] of Object.entries(operations)) {
    const doc = makeMongooseUserDoc({ itemLevel: 1725, horizonModeKey: "normal" });
    doc.weeklyResetKey = getTargetResetKey(new Date("2026-10-13T12:00:00Z"));
    const result = await run({ ...WRITE_TARGET, User: makeUserModel(doc) });
    assert.equal(result.ok, true, label);
    assert.equal(doc.weeklyResetKey, getTargetResetKey(afterReset), label);
    assert.equal(ensureFreshWeek(doc, afterReset), false, label);
    expectations[label](doc);
  }
});
