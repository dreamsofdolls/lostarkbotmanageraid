"use strict";

const { t: translate, DEFAULT_LANGUAGE } = require("../../../services/i18n");

/**
 * Build the seed-and-retry Bible roster fetcher.
 *
 * The three fallback messages are read from `raid-edit-roster.fallback.*`.
 * They were previously hardcoded Vietnamese here even though all three
 * locales already carried the translation, so en/jp users saw Vietnamese.
 *
 * @param {Object} deps
 * @param {Function} deps.fetchRosterCharacters
 * @param {Function} deps.normalizeName
 * @param {Function} deps.parseCombatScore
 * @param {Function} [deps.t] - injected for tests
 * @returns {Function} fetchBibleRosterWithFallback(savedChars, accountName, lang)
 */
function createFetchBibleRosterWithFallback({
  fetchRosterCharacters,
  normalizeName,
  parseCombatScore,
  t = translate,
}) {
  return async function fetchBibleRosterWithFallback(
    savedChars,
    accountName,
    lang = DEFAULT_LANGUAGE
  ) {
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
      return {
        bibleChars: [],
        bibleError: t("raid-edit-roster.fallback.noSeed", lang),
      };
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
        t(
          zeroOverlapHit
            ? "raid-edit-roster.fallback.zeroOverlap"
            : "raid-edit-roster.fallback.noResults",
          lang
        ),
    };
  };
}

module.exports = {
  createFetchBibleRosterWithFallback,
};
