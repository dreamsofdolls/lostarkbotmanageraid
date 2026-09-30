"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findSelectableCharacterRow,
  getSelectableCharacterRows,
  loadSelectableCharacterRow,
  characterSelectOptions,
} = require("../bot/handlers/raid/schedule/view/select-options");

const event = {
  raidKey: "armoche",
  minItemLevel: 1700,
};

const userDoc = {
  accounts: [{
    accountName: "Roster",
    characters: [
      { id: "char-low", name: "TooLow", class: "Bard", itemLevel: 1699, assignedRaids: {} },
      { id: "char-ready", name: "Ready", class: "Berserker", itemLevel: 1710, assignedRaids: {} },
    ],
  }],
};

test("schedule picker selection and ID lookup share one eligibility path", () => {
  const { selectable, allCleared } = getSelectableCharacterRows(userDoc, event);

  assert.equal(allCleared, false);
  assert.deepEqual(selectable.map((row) => [row.characterId, row.name]), [["char-ready", "Ready"]]);
  assert.equal(findSelectableCharacterRow(userDoc, event, "char-ready")?.name, "Ready");
  assert.equal(findSelectableCharacterRow(userDoc, event, "char-low"), null);
  assert.equal(findSelectableCharacterRow(userDoc, event, "missing"), null);
  assert.equal(findSelectableCharacterRow(userDoc, event, "1"), null);
  assert.equal(findSelectableCharacterRow(userDoc, event, undefined), null);
});

test("schedule picker reload resolves the latest character row by Discord owner", async () => {
  const queries = [];
  const UserModel = {
    findOne(query) {
      queries.push(query);
      return { lean: async () => userDoc };
    },
  };

  const row = await loadSelectableCharacterRow(UserModel, "owner-1", event, "char-ready");

  assert.deepEqual(queries, [{ discordId: "owner-1" }]);
  assert.equal(row?.name, "Ready");
});

test("an open picker keeps the selected character after another character is removed", async () => {
  const character = name => ({ id: `id-${name}`, name, class: "Bard", itemLevel: 1800 });
  const characters = ["Alpha", "Beta", "Gamma"].map(character);
  const roster = { accounts: [{ accountName: "Roster", characters }] };
  const options = characterSelectOptions(getSelectableCharacterRows(roster, event).selectable, "en");
  const selected = options.find(option => option.label === "Beta");
  roster.accounts[0].characters = [characters[1], characters[2]];

  const row = await loadSelectableCharacterRow(
    { findOne: () => ({ lean: async () => roster }) }, "owner", event, selected.value
  );
  assert.equal(row.name, "Beta");

  roster.accounts[0].characters.reverse();
  assert.equal(findSelectableCharacterRow(roster, event, selected.value).name, "Beta");
});

test("a picker rejects a removed or newly ineligible character instead of substituting one", () => {
  const ready = userDoc.accounts[0].characters[1];
  const withCharacter = character => ({ accounts: [{ accountName: "Roster", characters: [character] }] });
  assert.equal(findSelectableCharacterRow(withCharacter({ ...ready, id: "replacement" }), event, ready.id), null);
  assert.equal(findSelectableCharacterRow(withCharacter({ ...ready, itemLevel: 1699 }), event, ready.id), null);
  assert.equal(findSelectableCharacterRow(withCharacter({
    ...ready, assignedRaids: { armoche: { G1: { completedDate: 1 }, G2: { completedDate: 1 } } },
  }), event, ready.id), null);
});
