"use strict";

const { TRANSLATIONS, DEFAULT_LANGUAGE } = require("../../../locales");

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
