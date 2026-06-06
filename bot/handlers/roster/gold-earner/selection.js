"use strict";

const {
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
} = require("./constants");

function pickInitialSelection(chars) {
  const anyExisting = chars.some((c) => c.isGoldEarner);
  if (anyExisting) {
    return new Set(
      chars.map((c, i) => (c.isGoldEarner ? i : -1)).filter((i) => i >= 0)
    );
  }
  const ranked = chars
    .map((c, i) => ({ i, itemLevel: Number(c.itemLevel) || 0 }))
    .sort((a, b) => b.itemLevel - a.itemLevel)
    .slice(0, GOLD_EARNER_CAP_PER_ACCOUNT);
  return new Set(ranked.map((r) => r.i));
}

function findAccountByRoster(accounts, rosterInput, normalizeName) {
  const target = normalizeName(rosterInput);
  return (Array.isArray(accounts) ? accounts : []).find(
    (account) => normalizeName(account?.accountName) === target
  );
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
    isGoldEarner: !!character.isGoldEarner,
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
  findAccountByRoster,
  sortCharactersForPicker,
  buildPickerCharacters,
};
