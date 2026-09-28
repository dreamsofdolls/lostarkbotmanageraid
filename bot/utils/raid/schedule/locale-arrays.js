/**
 * utils/raid/schedule/locale-arrays.js
 * Locale-aware lookup for array-shaped translation entries (variant
 * pools like maintenance reminders, cleanup tone variants). Falls
 * through to DEFAULT_LANGUAGE on a miss · returns [] when both the
 * viewer's language and the default lack the key, so callers can guard
 * on `pool.length === 0` without try/catch.
 */

"use strict";

const { TRANSLATIONS, DEFAULT_LANGUAGE } = require("../../../locales");
const { applyVars, lookupKey } = require("../../../services/i18n");

/**
 * Look up an array translation by dotted path with language fallback.
 * @param {string} lang - viewer language code (vi/en/jp)
 * @param {string} dottedKey - dotted path inside the locale tree (e.g. "announcements.maintenance-early.T-3h")
 * @returns {string[]} array entries or [] when the key isn't an array in either tree
 */
function lookupArray(lang, dottedKey) {
  const tryPath = (code) => {
    const cursor = lookupKey(TRANSLATIONS[code], dottedKey);
    return Array.isArray(cursor) ? cursor : null;
  };
  return tryPath(lang) || tryPath(DEFAULT_LANGUAGE) || [];
}

/**
 * Pick one entry of a variant pool at random and fill its {name} slots.
 * @param {string[]} pool - entries from lookupArray
 * @param {object} [vars] - interpolation values; unknown slots stay literal
 * @returns {string} the chosen entry, or "" for an empty pool
 */
function pickArrayVariant(pool, vars) {
  if (pool.length === 0) return "";
  return applyVars(pool[Math.floor(Math.random() * pool.length)], vars);
}

module.exports = {
  lookupArray,
  pickArrayVariant,
};
