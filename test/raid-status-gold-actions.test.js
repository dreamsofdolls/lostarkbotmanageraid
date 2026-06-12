"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseGoldToggleValue,
  replaceRaidGoldSelection,
  toggleRaidGoldDisabled,
  getNextGoldOverride,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const User = require("../bot/models/User");

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
function makeMongooseUserDoc({ itemLevel = 1753, horizonModeKey = "nightmare" } = {}) {
  const doc = new User({
    discordId: "user-1",
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            id: "c1",
            name: "Aki",
            class: "Aeromancer",
            itemLevel,
            assignedRaids: {
              armoche: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
              kazeros: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
              serca: { modeKey: "hard", G1: { difficulty: "Hard", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } },
              horizon: { modeKey: horizonModeKey },
            },
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

test("raid-status gold actions parse valid raid toggle values", () => {
  assert.deepEqual(parseGoldToggleValue("Aki::horizon"), {
    kind: "single",
    targetCharName: "Aki",
    raidKey: "horizon",
  });
  assert.deepEqual(parseGoldToggleValue("Aki::missing"), { kind: "invalid" });
  assert.deepEqual(parseGoldToggleValue("noop"), { kind: "noop" });
});

test("raid-status gold actions cycle bound raid through include, exclude, auto", async () => {
  let saved = 0;
  const doc = {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            assignedRaids: {
              horizon: {
                modeKey: "hard",
                G1: { difficulty: "Hard", completedDate: null },
                G2: { difficulty: "Hard", completedDate: null },
              },
            },
          },
        ],
      },
    ],
    markModified(path) {
      assert.equal(path, "accounts");
    },
    async save() {
      saved += 1;
    },
  };

  await toggleRaidGoldDisabled({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldDisabled, undefined);

  await toggleRaidGoldDisabled({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "exclude");

  await toggleRaidGoldDisabled({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, undefined);
  assert.equal(saved, 3);
});

test("raid-status gold override survives Mongoose subdoc serialization (toggle)", async () => {
  // ilvl 1705 keeps only Act 4 (1700) + Horizon (1700) eligible · Kazeros and
  // Serca normal need 1710. With one unbound raid receiving the 3-slot cap has
  // room, so toggling Horizon takes the direct-save path (no replacement) -
  // exactly the path that silently dropped the override before the fix.
  const doc = makeMongooseUserDoc({ itemLevel: 1705, horizonModeKey: "normal" });
  const result = await toggleRaidGoldDisabled({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });
  assert.equal(result.needsReplacement, false);
  // Regression guard: the override must be present in the SERIALIZED doc, not
  // just on the in-memory subdoc wrapper. Before the plain-object re-cast fix
  // this read undefined even though the in-memory assignment "succeeded".
  assert.equal(horizonOverrideOf(doc), "include");
});

test("raid-status gold replacement survives Mongoose subdoc serialization", async () => {
  const doc = makeMongooseUserDoc();
  const replace = await replaceRaidGoldSelection({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    includeRaidKey: "horizon",
    excludeRaidKey: "armoche",
  });
  assert.equal(replace.ok, true);
  const raids = doc.toObject().accounts[0].characters[0].assignedRaids;
  assert.equal(raids.horizon.goldOverride, "include");
  assert.equal(raids.armoche.goldOverride, "exclude");
  // The re-cast must preserve the rest of the entry, not just the new field.
  assert.equal(raids.armoche.G1.completedDate, 1);
});

test("raid-status gold actions report ok=false when target cannot be saved", async () => {
  const result = await toggleRaidGoldDisabled({
    User: makeUserModel({ accounts: [] }),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });

  assert.equal(result.ok, false);
  assert.equal(result.override, null);
});

test("raid-status gold actions toggle unbound auto raid to manual exclude", () => {
  assert.equal(getNextGoldOverride("kazeros", {
    modeKey: "normal",
    G1: { difficulty: "Normal", completedDate: null },
    G2: { difficulty: "Normal", completedDate: null },
  }, { itemLevel: 1710 }), "exclude");
  assert.equal(getNextGoldOverride("kazeros", {
    modeKey: "hard",
    G1: { difficulty: "Hard", completedDate: null },
    G2: { difficulty: "Hard", completedDate: null },
  }), "exclude");
  assert.equal(getNextGoldOverride("kazeros", {}, { itemLevel: 1730 }), "exclude");
});

test("raid-status gold actions toggle full-bound Horizon auto raid to manual include", () => {
  assert.equal(getNextGoldOverride("horizon", {
    modeKey: "normal",
    G1: { difficulty: "Level 1", completedDate: null },
    G2: { difficulty: "Level 1", completedDate: null },
  }, { itemLevel: 1710 }), "include");
});

test("raid-status gold actions require replacement before including locked raid at 3/3", async () => {
  let saved = 0;
  const doc = {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            itemLevel: 1730,
            assignedRaids: {
              horizon: {
                modeKey: "hard",
                G1: { difficulty: "Level 2", completedDate: null },
                G2: { difficulty: "Level 2", completedDate: null },
              },
            },
          },
        ],
      },
    ],
    markModified() {},
    async save() {
      saved += 1;
    },
  };

  const result = await toggleRaidGoldDisabled({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    raidKey: "horizon",
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsReplacement, true);
  assert.equal(saved, 0);
  assert.deepEqual(
    result.replacement.options.map((raid) => raid.raidKey),
    ["armoche", "kazeros", "serca"],
  );

  const replace = await replaceRaidGoldSelection({
    User: makeUserModel(doc),
    saveWithRetry: async (op) => op(),
    discordId: "user-1",
    targetAccountName: "Roster",
    targetCharName: "Aki",
    includeRaidKey: "horizon",
    excludeRaidKey: "armoche",
  });

  assert.equal(replace.ok, true);
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(doc.accounts[0].characters[0].assignedRaids.armoche.goldOverride, "exclude");
  assert.equal(saved, 1);
});
