/**
 * bot/services/auto-manage/bible/error-kinds.js
 * Sorts Bible failures into the kinds a user acts on differently. Reports
 * keep only the error message (runtime/pipeline/gather.js), so every check
 * works on a message string as well as on the Error.
 */

"use strict";

const { isBibleRateLimitError } = require("./rate-limit");

const BIBLE_ERROR_KIND = Object.freeze({
  rateLimit: "rateLimit",
  publicLogOff: "publicLogOff",
  blocked: "blocked",
  notFound: "notFound",
  other: "other",
});

const CHARACTER_NOT_FOUND_PATTERN = /lostark\.bible has no character "/;

function errorText(error) {
  return error?.message || String(error || "");
}

/**
 * lostark.bible answers an unknown name with HTTP 200 and a "Character Not
 * Found" page, so this error is the only not-found signal.
 * @param {string} charName
 * @returns {Error}
 */
function createBibleCharacterNotFoundError(charName) {
  return new Error(`lostark.bible has no character "${charName}"`);
}

/**
 * @param {unknown} error - an Error or an error message
 * @returns {boolean} true when the logs API refused a character whose Public Log is off
 */
function isPublicLogDisabledError(error) {
  return /logs\s*not\s*enabled/i.test(errorText(error));
}

/**
 * @param {unknown} error - an Error or an error message
 * @returns {string} one of BIBLE_ERROR_KIND
 */
function classifyBibleError(error) {
  const text = errorText(error);
  // First, because this message carries a character name that the loose
  // rate-limit pattern can match ("Ratelimit" is a valid name).
  if (CHARACTER_NOT_FOUND_PATTERN.test(text)) return BIBLE_ERROR_KIND.notFound;
  if (isBibleRateLimitError(error)) return BIBLE_ERROR_KIND.rateLimit;
  // Before blocked: the logs API refuses a private character with 403 too.
  if (isPublicLogDisabledError(error)) return BIBLE_ERROR_KIND.publicLogOff;
  if (Number(error?.status) === 403 || /\bHTTP 403\b/.test(text)) {
    return BIBLE_ERROR_KIND.blocked;
  }
  return BIBLE_ERROR_KIND.other;
}

module.exports = {
  BIBLE_ERROR_KIND,
  classifyBibleError,
  createBibleCharacterNotFoundError,
  isPublicLogDisabledError,
};
