"use strict";

function sameName(left, right) {
  return String(left || "").trim().toLowerCase() ===
    String(right || "").trim().toLowerCase();
}

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
    if (candidates.length === 0) return null;
    if (explicit) {
      const stillExists = candidates.find((character) =>
        sameName(getCharacterName(character), explicit)
      );
      if (stillExists) return getCharacterName(stillExists);
    }
    return getCharacterName(candidates[0]);
  }

  function activeGoldCharacter() {
    const activeName = resolveGoldCharFilter();
    if (!activeName) return null;
    const account = getAccounts()[getCurrentPage()];
    return (account?.characters || []).find((character) =>
      sameName(getCharacterName(character), activeName)
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
  sameName,
};
