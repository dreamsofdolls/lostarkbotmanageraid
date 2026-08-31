"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findSelectableCharacterRow,
  getSelectableCharacterRows,
  loadSelectableCharacterRow,
} = require("../bot/handlers/raid/schedule/view/select-options");

const event = {
  raidKey: "armoche",
  minItemLevel: 1700,
};

const userDoc = {
  accounts: [{
    accountName: "Roster",
    characters: [
      { name: "TooLow", class: "Bard", itemLevel: 1699, assignedRaids: {} },
      { name: "Ready", class: "Berserker", itemLevel: 1710, assignedRaids: {} },
    ],
  }],
};

test("schedule picker selection and stale-index lookup share one eligibility path", () => {
  const { selectable, allCleared } = getSelectableCharacterRows(userDoc, event);

  assert.equal(allCleared, false);
  assert.deepEqual(selectable.map((row) => [row.index, row.name]), [[1, "Ready"]]);
  assert.equal(findSelectableCharacterRow(userDoc, event, "1")?.name, "Ready");
  assert.equal(findSelectableCharacterRow(userDoc, event, "99"), null);
});

test("schedule picker reload resolves the latest character row by Discord owner", async () => {
  const queries = [];
  const UserModel = {
    findOne(query) {
      queries.push(query);
      return { lean: async () => userDoc };
    },
  };

  const row = await loadSelectableCharacterRow(UserModel, "owner-1", event, 1);

  assert.deepEqual(queries, [{ discordId: "owner-1" }]);
  assert.equal(row?.name, "Ready");
});
