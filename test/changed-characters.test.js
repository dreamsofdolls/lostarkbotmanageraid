"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EMBED_FIELD_LIMIT,
  appendGroupFields,
  buildCharacterStatusField,
  touchedRaidLines,
} = require("../bot/utils/raid/common/changed-characters");

const DONE = { difficulty: "Hard", completedDate: 200 };
const OPEN = { difficulty: "Hard", completedDate: 0 };
const CHARACTER = {
  name: "Duskfox",
  class: "Sorceress",
  itemLevel: 1750,
  isGoldEarner: true,
  assignedRaids: { kazeros: { modeKey: "hard", G1: DONE, G2: OPEN } },
};

test("a character card uses the /raid-status name and one row per line", () => {
  const field = buildCharacterStatusField(CHARACTER, ["row one", "row two"]);

  assert.match(field.name, /Duskfox · 1750$/u);
  assert.equal(field.value, "row one\nrow two");
  assert.equal(field.inline, true);
});

test("touched raid rows keep only the raids the sync wrote", () => {
  assert.deepEqual(touchedRaidLines(CHARACTER, new Set(["kazeros::hard"]), "en"), ["🟡 Kazeros Hard · 1/2"]);
  assert.deepEqual(touchedRaidLines(CHARACTER, new Set(["serca::hard"]), "en"), []);
});

test("grouped character fields never pass Discord's field cap", () => {
  const fields = [];
  const cards = Array.from({ length: 20 }, (_, index) => ({ name: `C${index}`, value: "row", inline: true }));
  appendGroupFields(fields, { name: "header", value: "​", inline: false }, cards);

  assert.ok(fields.length <= EMBED_FIELD_LIMIT);
  assert.equal(fields[0].name, "header");
});
