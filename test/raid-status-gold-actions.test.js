"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseGoldToggleValue,
  toggleRaidGoldDisabled,
  getNextGoldOverride,
} = require("../bot/handlers/raid-status/gold/gold-actions");

function makeUserModel(doc) {
  return {
    async findOne() {
      return doc;
    },
  };
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
    modeKey: "hard",
    G1: { difficulty: "Hard", completedDate: null },
    G2: { difficulty: "Hard", completedDate: null },
  }), "exclude");
  assert.equal(getNextGoldOverride("kazeros", {}, { itemLevel: 1730 }), "exclude");
});
