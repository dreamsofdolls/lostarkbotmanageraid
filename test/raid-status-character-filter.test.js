"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCharacterNameFilter,
  sameCharacterName,
} = require("../bot/handlers/raid-status/state/character-filter");

const getCharacterName = (character) => character.name;

test("raid-status character filter compares normalized names", () => {
  assert.equal(sameCharacterName("  Artist  ", "artist"), true);
  assert.equal(sameCharacterName("Artist", "Bard"), false);
});

test("raid-status character filter keeps an explicit match or falls back to the first candidate", () => {
  const candidates = [{ name: "Artist" }, { name: "Bard" }];

  assert.equal(resolveCharacterNameFilter({
    candidates,
    explicit: " bard ",
    getCharacterName,
  }), "Bard");
  assert.equal(resolveCharacterNameFilter({
    candidates,
    explicit: "Missing",
    getCharacterName,
  }), "Artist");
  assert.equal(resolveCharacterNameFilter({
    candidates: [],
    explicit: "Artist",
    getCharacterName,
  }), null);
});

test("raid-status character filter preserves the all-characters sentinel", () => {
  assert.equal(resolveCharacterNameFilter({
    allCharactersSentinel: "__ALL_CHARS__",
    candidates: [{ name: "Artist" }],
    explicit: "__ALL_CHARS__",
    getCharacterName,
  }), "__ALL_CHARS__");
});
