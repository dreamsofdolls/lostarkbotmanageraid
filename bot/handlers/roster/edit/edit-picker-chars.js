"use strict";

// lostark.bible keeps a character's id (`cid`) through a rename, so a saved
// character Bible no longer lists and a Bible character nobody saved, with
// one id, are the same character under a new name. Returns savedKey ->
// bibleKey for each such pair.
function pairRenamedCharacters(savedMap, bibleMap) {
  const bibleKeyByCid = new Map();
  for (const [key, bible] of bibleMap) {
    if (bible.cid && !savedMap.has(key)) bibleKeyByCid.set(bible.cid, key);
  }
  const renamedTo = new Map();
  for (const [key, saved] of savedMap) {
    const bibleKey = bibleMap.has(key) ? null : bibleKeyByCid.get(saved.bibleCid);
    if (!bibleKey) continue;
    renamedTo.set(key, bibleKey);
    bibleKeyByCid.delete(saved.bibleCid);
  }
  return renamedTo;
}

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
  // A renamed character is one row: the saved record under its Bible name.
  const renamedTo = pairRenamedCharacters(savedMap, bibleMap);
  const pairedBibleKeys = new Set(renamedTo.values());

  const merged = [];
  for (const key of allKeys) {
    if (pairedBibleKeys.has(key)) continue;
    const saved = savedMap.get(key);
    const bible = bibleMap.get(renamedTo.get(key) || key);
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
