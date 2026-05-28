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

/**
 * Look up an array translation by dotted path with language fallback.
 * @param {string} lang - viewer language code (vi/en/jp)
 * @param {string} dottedKey - dotted path inside the locale tree (e.g. "announcements.maintenance-early.T-3h")
 * @returns {string[]} array entries or [] when the key isn't an array in either tree
 */
function lookupArray(lang, dottedKey) {
  const tryPath = (code) => {
    const tree = TRANSLATIONS[code];
    if (!tree) return null;
    let cursor = tree;
    for (const seg of dottedKey.split(".")) {
      if (cursor == null || typeof cursor !== "object") return null;
      cursor = cursor[seg];
    }
    return Array.isArray(cursor) ? cursor : null;
  };
  return tryPath(lang) || tryPath(DEFAULT_LANGUAGE) || [];
}

module.exports = {
  lookupArray,
};
