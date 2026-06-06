"use strict";

const {
  foldName,
  getCharacterClass,
  getCharacterName,
  normalizeName,
} = require("../shared");

function buildFetchedRosterIndexes(fetchedChars) {
  const byName = new Map();
  const byFoldedName = new Map();

  for (const fetched of fetchedChars || []) {
    const charName = fetched?.charName;
    const normalized = normalizeName(charName);
    if (!normalized) continue;

    byName.set(normalized, fetched);

    const folded = foldName(charName);
    if (!folded) continue;
    if (!byFoldedName.has(folded)) byFoldedName.set(folded, []);
    byFoldedName.get(folded).push(fetched);
  }

  return { byName, byFoldedName };
}

function pickUniqueFetchedRosterCandidate(candidates, character) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const storedClass = normalizeName(getCharacterClass(character));
  const classMatches = storedClass
    ? candidates.filter((c) => normalizeName(c?.className) === storedClass)
    : [];
  if (classMatches.length === 1) return classMatches[0];

  const narrowed = classMatches.length > 0 ? classMatches : candidates;
  const storedItemLevel = Number(character?.itemLevel) || 0;
  if (storedItemLevel > 0) {
    const closeMatches = narrowed.filter((c) => {
      const fetchedItemLevel = Number(c?.itemLevel) || 0;
      return fetchedItemLevel > 0 && Math.abs(fetchedItemLevel - storedItemLevel) < 2;
    });
    if (closeMatches.length === 1) return closeMatches[0];
  }

  return null;
}

function findFetchedRosterMatchForCharacter(character, indexes) {
  const currentName = getCharacterName(character);
  const exact = indexes?.byName?.get(normalizeName(currentName));
  if (exact) return { match: exact, matchType: "exact" };

  const folded = foldName(currentName);
  if (!folded) return null;

  const foldedCandidates = indexes?.byFoldedName?.get(folded) || [];
  const foldedMatch = pickUniqueFetchedRosterCandidate(foldedCandidates, character);
  if (!foldedMatch) return null;

  return { match: foldedMatch, matchType: "folded" };
}

module.exports = {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  pickUniqueFetchedRosterCandidate,
};
