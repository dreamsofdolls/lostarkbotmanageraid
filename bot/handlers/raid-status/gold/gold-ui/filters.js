"use strict";

const {
  resolveCharacterNameFilter,
  sameCharacterName,
} = require("../../state/character-filter");

function createGoldFilterState({
  getAccounts,
  getCurrentPage,
  getGoldCharFilter,
  getCharacterName,
  getRaidsFor,
}) {
  function goldCharactersOnPage() {
    const account = getAccounts()[getCurrentPage()];
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    return characters.filter((character) => {
      if (character?.isGoldEarner === false) return false;
      return getRaidsFor(character).length > 0;
    });
  }

  function resolveGoldCharFilter() {
    const explicit = getGoldCharFilter(getCurrentPage());
    const candidates = goldCharactersOnPage();
    return resolveCharacterNameFilter({
      candidates,
      explicit,
      getCharacterName,
    });
  }

  function activeGoldCharacter() {
    const activeName = resolveGoldCharFilter();
    if (!activeName) return null;
    const account = getAccounts()[getCurrentPage()];
    return (account?.characters || []).find((character) =>
      sameCharacterName(getCharacterName(character), activeName)
    ) || null;
  }

  return {
    activeGoldCharacter,
    goldCharactersOnPage,
    resolveGoldCharFilter,
  };
}

module.exports = {
  createGoldFilterState,
};
