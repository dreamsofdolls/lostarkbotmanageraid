"use strict";

const {
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
} = require("./constants");
const { isGoldEarner } = require("../../../utils/raid/common/character");

// Existing earners when there are any, else every character; either way the
// 6 highest item levels, so the picker never opens above the cap (a roster
// added before this command ran has every character flagged).
function pickInitialSelection(chars) {
  const anyExisting = chars.some((c) => c.isGoldEarner);
  const ranked = chars
    .map((c, i) => ({ i, itemLevel: Number(c.itemLevel) || 0, earner: c.isGoldEarner }))
    .filter((entry) => !anyExisting || entry.earner)
    .sort((a, b) => b.itemLevel - a.itemLevel)
    .slice(0, GOLD_EARNER_CAP_PER_ACCOUNT);
  return new Set(ranked.map((r) => r.i));
}

function sortCharactersForPicker(characters) {
  return [...(Array.isArray(characters) ? characters : [])].sort(
    (a, b) => (Number(b.itemLevel) || 0) - (Number(a.itemLevel) || 0)
  );
}

function toPickerCharacter(character) {
  return {
    id: character.id,
    name: character.name,
    class: character.class,
    itemLevel: Number(character.itemLevel) || 0,
    isGoldEarner: isGoldEarner(character),
  };
}

function buildPickerCharacters(characters) {
  const sortedAll = sortCharactersForPicker(characters);
  return {
    chars: sortedAll.slice(0, PICKER_MAX_OPTIONS).map(toPickerCharacter),
    overflowCount: Math.max(0, sortedAll.length - PICKER_MAX_OPTIONS),
  };
}

module.exports = {
  pickInitialSelection,
  buildPickerCharacters,
};
