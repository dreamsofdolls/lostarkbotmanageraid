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
 * @returns {(savedChars: Array<object>, accountName: string, lang?: string) =>
 *   Promise<{bibleChars: Array<object>, bibleError: string|null}>}
 *   fetchBibleRosterWithFallback
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
    const seenSeeds = new Set();
    // Preserve highest-combat-score retry priority, append the account name as
    // the final fallback, and avoid duplicate network attempts in constant time.
    const sortedSaved = [...savedChars].sort(
      (a, b) => parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore)
    );

    for (const character of sortedSaved) {
      if (character.name && !seenSeeds.has(character.name)) {
        seeds.push(character.name);
        seenSeeds.add(character.name);
      }
    }
    if (accountName && !seenSeeds.has(accountName)) {
      seeds.push(accountName);
      seenSeeds.add(accountName);
    }

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
          // Stop on the first overlap; the saved-name index avoids rebuilding or
          // rescanning the saved roster for every fetched character.
          const hasOverlap = fetched.some((character) =>
            savedNameSet.has(normalizeName(character.charName))
          );
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
