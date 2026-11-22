"use strict";

const { sameCharacterName } = require("../../state/character-filter");
const { countedGoldEarners } = require("../../../../utils/raid/common/character");

/**
 * Character selection of the gold view on the current page.
 * @param {object} deps
 * @param {() => object[]} deps.getAccounts - accounts in page order
 * @param {() => number} deps.getCurrentPage - current page index
 * @param {(page: number) => string[]|undefined} deps.getGoldCharSelection - stored names for a page
 * @param {(page: number) => string[]|undefined} [deps.getVisibilityCharSelection] - stored names for visibility mode
 * @param {(character: object) => string} deps.getCharacterName - display name of a character
 * @param {(character: object) => object[]} deps.getRaidsFor - status raids of a character
 * @returns {{goldCharactersOnPage: () => object[], resolveGoldCharSelection: () => string[], selectedGoldCharacters: () => object[], visibilityCharactersOnPage: () => object[], resolveVisibilityCharSelection: () => string[], selectedVisibilityCharacters: () => object[]}}
 */
function createGoldFilterState({
  getAccounts,
  getCurrentPage,
  getGoldCharSelection,
  getVisibilityCharSelection = getGoldCharSelection,
  getCharacterName,
  getRaidsFor,
}) {
  function currentAccountCharacters() {
    const account = getAccounts()[getCurrentPage()];
    return Array.isArray(account?.characters) ? account.characters : [];
  }

  function goldCharactersOnPage() {
    const characters = currentAccountCharacters();
    const counted = countedGoldEarners(characters);
    return characters.filter((character) => {
      if (!counted.has(character)) return false;
      return getRaidsFor(character).length > 0;
    });
  }

  function visibilityCharactersOnPage() {
    return currentAccountCharacters().filter((character) => getRaidsFor(character).length > 0);
  }

  function resolveSelectedNames(candidates, getSelection) {
    if (candidates.length === 0) return [];
    const stored = getSelection(getCurrentPage());
    const wanted = Array.isArray(stored) ? stored : [];
    const picked = candidates
      .map(getCharacterName)
      .filter((name) => wanted.some((want) => sameCharacterName(want, name)));
    return picked.length > 0 ? picked : [getCharacterName(candidates[0])];
  }

  function filterSelectedCharacters(candidates, names) {
    return candidates.filter((character) =>
      names.some((name) => sameCharacterName(name, getCharacterName(character)))
    );
  }

  /**
   * Names of the selected gold characters on the current page, in roster
   * order. Stored names that are no longer candidates are dropped; an empty
   * result falls back to the first candidate.
   * @returns {string[]} empty only when the page has no gold candidate
   */
  function resolveGoldCharSelection() {
    return resolveSelectedNames(goldCharactersOnPage(), getGoldCharSelection);
  }

  function selectedGoldCharacters() {
    return filterSelectedCharacters(goldCharactersOnPage(), resolveGoldCharSelection());
  }

  function resolveVisibilityCharSelection() {
    return resolveSelectedNames(visibilityCharactersOnPage(), getVisibilityCharSelection);
  }

  function selectedVisibilityCharacters() {
    return filterSelectedCharacters(visibilityCharactersOnPage(), resolveVisibilityCharSelection());
  }

  return {
    goldCharactersOnPage,
    resolveGoldCharSelection,
    selectedGoldCharacters,
    visibilityCharactersOnPage,
    resolveVisibilityCharSelection,
    selectedVisibilityCharacters,
  };
}

module.exports = {
  createGoldFilterState,
};
