"use strict";

function createFetchBibleRosterWithFallback({
  fetchRosterCharacters,
  normalizeName,
  parseCombatScore,
}) {
  return async function fetchBibleRosterWithFallback(savedChars, accountName) {
    const seeds = [];
    const sortedSaved = [...savedChars].sort(
      (a, b) => parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore)
    );

    for (const character of sortedSaved) {
      if (character.name && !seeds.includes(character.name)) {
        seeds.push(character.name);
      }
    }
    if (accountName && !seeds.includes(accountName)) seeds.push(accountName);

    if (seeds.length === 0) {
      return { bibleChars: [], bibleError: "Không có seed để fetch bible." };
    }

    const savedNameSet = new Set(
      savedChars.map((character) => normalizeName(character.name)).filter(Boolean)
    );

    let lastError = null;
    let zeroOverlapHit = false;
    for (const seed of seeds) {
      try {
        const fetched = await fetchRosterCharacters(seed);
        if (!Array.isArray(fetched) || fetched.length === 0) continue;

        if (savedNameSet.size > 0) {
          const fetchedNames = new Set(
            fetched.map((character) => normalizeName(character.charName))
          );
          const hasOverlap = [...savedNameSet].some((name) => fetchedNames.has(name));
          if (!hasOverlap) {
            zeroOverlapHit = true;
            console.warn(
              `[edit-roster] seed "${seed}" returned ${fetched.length} chars but zero overlap with saved roster - trying next seed.`
            );
            continue;
          }
        }

        return { bibleChars: fetched, bibleError: null };
      } catch (err) {
        lastError = err?.message || String(err);
        console.warn(`[edit-roster] seed "${seed}" failed: ${lastError}`);
      }
    }

    return {
      bibleChars: [],
      bibleError:
        lastError ||
        (zeroOverlapHit
          ? "Mọi seed đều trả roster không trùng saved chars (rename in-game?)"
          : "Bible không trả về kết quả nào."),
    };
  };
}

module.exports = {
  createFetchBibleRosterWithFallback,
};
