"use strict";

function buildEditRosterPickerChars({
  savedChars,
  bibleChars,
  cap,
  normalizeName,
  parseCombatScore,
}) {
  const savedMap = new Map(savedChars.map((character) => [normalizeName(character.name), character]));
  const bibleMap = new Map(bibleChars.map((character) => [normalizeName(character.charName), character]));
  const allKeys = new Set([...savedMap.keys(), ...bibleMap.keys()]);

  const merged = [];
  for (const key of allKeys) {
    const saved = savedMap.get(key);
    const bible = bibleMap.get(key);
    merged.push({
      charName: bible?.charName || saved.name,
      className: bible?.className || saved.class,
      itemLevel: bible?.itemLevel ?? saved.itemLevel,
      combatScore: bible?.combatScore || saved.combatScore,
      savedKey: saved ? key : null,
      inBible: !!bible,
    });
  }

  merged.sort((a, b) => {
    const aIsSaved = a.savedKey ? 1 : 0;
    const bIsSaved = b.savedKey ? 1 : 0;
    if (aIsSaved !== bIsSaved) return bIsSaved - aIsSaved;
    const cpDiff = parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore);
    if (cpDiff !== 0) return cpDiff;
    return (b.itemLevel || 0) - (a.itemLevel || 0);
  });

  const displayChars = merged.slice(0, cap);
  const excluded = merged.slice(cap);
  let excludedBibleOnlyCount = 0;
  let excludedSavedCount = 0;
  const excludedSavedKeys = new Set();

  for (const character of excluded) {
    if (character.savedKey) {
      excludedSavedCount += 1;
      excludedSavedKeys.add(character.savedKey);
    } else {
      excludedBibleOnlyCount += 1;
    }
  }

  return {
    merged,
    displayChars,
    excludedBibleOnlyCount,
    excludedSavedCount,
    excludedSavedKeys,
  };
}

module.exports = {
  buildEditRosterPickerChars,
};
