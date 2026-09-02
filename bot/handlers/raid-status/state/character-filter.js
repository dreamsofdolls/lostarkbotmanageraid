"use strict";

const { normalizeName } = require("../../../utils/raid/common/shared");

function sameCharacterName(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function resolveCharacterNameFilter({
  candidates,
  explicit,
  getCharacterName,
  allCharactersSentinel = null,
}) {
  if (candidates.length === 0) return null;
  if (allCharactersSentinel !== null && explicit === allCharactersSentinel) {
    return allCharactersSentinel;
  }

  const selected = explicit
    ? candidates.find((character) =>
        sameCharacterName(getCharacterName(character), explicit)
      )
    : null;
  return getCharacterName(selected || candidates[0]);
}

module.exports = {
  resolveCharacterNameFilter,
  sameCharacterName,
};
