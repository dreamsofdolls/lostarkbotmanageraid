"use strict";

const { sameCharacterName } = require("../../state/character-filter");
const { countedGoldEarners } = require("../../../../utils/raid/common/character");

function createGoldFilterState({
  getAccounts,
  getCurrentPage,
  getGoldCharSelection,
  getCharacterName,
  getRaidsFor,
}) {
  function goldCharactersOnPage() {
    const account = getAccounts()[getCurrentPage()];
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    const counted = countedGoldEarners(characters);
    return characters.filter((character) => {
      if (!counted.has(character)) return false;
      return getRaidsFor(character).length > 0;
    });
  }

  /**
   * Names of the selected gold characters on the current page, in roster
   * order. Stored names that are no longer candidates are dropped; an empty
   * result falls back to the first candidate.
   * @returns {string[]} empty only when the page has no gold candidate
   */
  function resolveGoldCharSelection() {
    const candidates = goldCharactersOnPage();
    if (candidates.length === 0) return [];
    const stored = getGoldCharSelection(getCurrentPage());
    const wanted = Array.isArray(stored) ? stored : [];
    const picked = candidates
      .map(getCharacterName)
      .filter((name) => wanted.some((want) => sameCharacterName(want, name)));
    return picked.length > 0 ? picked : [getCharacterName(candidates[0])];
  }

  function selectedGoldCharacters() {
    const names = resolveGoldCharSelection();
    return goldCharactersOnPage().filter((character) =>
      names.some((name) => sameCharacterName(name, getCharacterName(character)))
    );
  }

  return {
    goldCharactersOnPage,
    resolveGoldCharSelection,
    selectedGoldCharacters,
  };
}

module.exports = {
  createGoldFilterState,
};
