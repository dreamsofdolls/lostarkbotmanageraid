"use strict";

// Lost Ark pays raid gold to 6 characters per roster each week. Rosters added
// before /raid-gold-earner was run have every character flagged (the schema
// default), so every gold total must count only the 6 that the game pays.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countedGoldEarners,
  isGoldEarner,
  summarizeAccountGold,
} = require("../bot/utils/raid/common/character");
const {
  pickInitialSelection,
  buildPickerCharacters,
} = require("../bot/handlers/roster/gold-earner/selection");

// `count` characters, item level falling by one from 1760, all flagged.
function makeRoster(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    name: `Char${index}`,
    itemLevel: 1760 - index,
    isGoldEarner: true,
    ...overrides,
  }));
}

test("a missing isGoldEarner flag counts as an earner, an explicit false does not", () => {
  assert.equal(isGoldEarner({}), true);
  assert.equal(isGoldEarner({ isGoldEarner: true }), true);
  assert.equal(isGoldEarner({ isGoldEarner: false }), false);
});

test("only the 6 highest item levels among flagged characters earn gold", () => {
  const characters = makeRoster(10);
  characters[1].isGoldEarner = false;
  delete characters[4].isGoldEarner;

  const counted = countedGoldEarners(characters);
  assert.deepEqual(
    characters.filter((character) => counted.has(character)).map((character) => character.name),
    ["Char0", "Char2", "Char3", "Char4", "Char5", "Char6"]
  );
});

test("an account's weekly gold counts at most 6 earners", () => {
  const raid = { earnedGold: 20_000, totalGold: 140_000 };
  const gold = summarizeAccountGold({ characters: makeRoster(10) }, () => [raid]);
  assert.equal(gold.earned, 6 * 20_000);
  assert.equal(gold.total, 6 * 140_000);
});

test("the gold-earner picker preselects at most 6 existing earners, highest item level first", () => {
  const { chars } = buildPickerCharacters(makeRoster(10));
  const selected = pickInitialSelection(chars);
  assert.deepEqual([...selected].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("the gold-earner picker reads a missing flag as an earner", () => {
  const { chars } = buildPickerCharacters(makeRoster(3, { isGoldEarner: undefined }));
  assert.deepEqual(chars.map((character) => character.isGoldEarner), [true, true, true]);
});

test("the /raid-status gold view lists only the characters that earn gold", () => {
  const { createGoldFilterState } = require("../bot/handlers/raid-status/gold/gold-ui/filters");
  const characters = makeRoster(8);
  const { goldCharactersOnPage } = createGoldFilterState({
    getAccounts: () => [{ accountName: "Alpha", characters }],
    getCurrentPage: () => 0,
    getGoldCharFilter: () => null,
    getCharacterName: (character) => character.name,
    getRaidsFor: () => [{ raidKey: "kazeros" }],
  });
  assert.deepEqual(goldCharactersOnPage().map((character) => character.name), [
    "Char0", "Char1", "Char2", "Char3", "Char4", "Char5",
  ]);
});
