/**
 * bot/services/auto-manage/bible/error-kinds.js
 * Sorts Bible failures into the kinds a user acts on differently. Reports
 * keep only the error message (runtime/pipeline/gather.js), so every check
 * works on a message string as well as on the Error.
 */

"use strict";

const { getBibleHttpStatus, isBibleRateLimitError } = require("./rate-limit");

const BIBLE_ERROR_KIND = Object.freeze({
  rateLimit: "rateLimit",
  publicLogOff: "publicLogOff",
  blocked: "blocked",
  notFound: "notFound",
  other: "other",
});

// Read from the start of a message only: a message that carries a character
// name carries it later, and a name must never decide the kind. The logs API
// request sends no name, so its whole message is read.
const CHARACTER_NOT_FOUND_PATTERN = /^lostark\.bible has no character "/;
const PUBLIC_LOG_DISABLED_PATTERN =
  /^(?:Bible logs API returned HTTP \d{3} - .*)?logs\s*not\s*enabled/i;

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
  return PUBLIC_LOG_DISABLED_PATTERN.test(errorText(error));
}

/**
 * @param {unknown} error - an Error or an error message
 * @returns {string} one of BIBLE_ERROR_KIND
 */
function classifyBibleError(error) {
  if (CHARACTER_NOT_FOUND_PATTERN.test(errorText(error))) return BIBLE_ERROR_KIND.notFound;
  if (isBibleRateLimitError(error)) return BIBLE_ERROR_KIND.rateLimit;
  // Before blocked: the logs API refuses a private character with 403 too.
  if (isPublicLogDisabledError(error)) return BIBLE_ERROR_KIND.publicLogOff;
  if (getBibleHttpStatus(error) === 403) return BIBLE_ERROR_KIND.blocked;
  return BIBLE_ERROR_KIND.other;
}

module.exports = {
  BIBLE_ERROR_KIND,
  classifyBibleError,
  createBibleCharacterNotFoundError,
  isPublicLogDisabledError,
};
