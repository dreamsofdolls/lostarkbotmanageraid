/**
 * bot/services/auto-manage/bible/error-text.js
 * What a user reads for a Bible error: the label of its kind, or the raw
 * message when the kind is unknown.
 */

"use strict";

const { t } = require("../../i18n");
const { BIBLE_ERROR_KIND, classifyBibleError } = require("./error-kinds");

const MAX_ERROR_LENGTH = 180;

/**
 * @param {unknown} error - an Error or an error message
 * @param {string} lang
 * @returns {{kind: string, text: string}} the `common.bibleError` label of a
 *   known kind, or the raw message on one line without backticks, cut at
 *   MAX_ERROR_LENGTH characters
 */
function describeBibleError(error, lang) {
  const kind = classifyBibleError(error);
  if (kind !== BIBLE_ERROR_KIND.other) {
    return { kind, text: t(`common.bibleError.${kind}`, lang) };
  }
  // One line and no backtick, so the text fits inside a code span.
  const oneLine = String(error?.message || error).replace(/\s+/g, " ").trim().replace(/`/g, "'");
  return {
    kind,
    text: oneLine.length > MAX_ERROR_LENGTH
      ? `${oneLine.slice(0, MAX_ERROR_LENGTH - 1)}…`
      : oneLine,
  };
}

/**
 * @param {unknown} error - an Error or an error message
 * @param {string} lang
 * @returns {string} the label of a known kind, or the raw message in a code span
 */
function formatBibleError(error, lang) {
  const { kind, text } = describeBibleError(error, lang);
  return kind === BIBLE_ERROR_KIND.other ? `\`${text}\`` : text;
}

module.exports = {
  describeBibleError,
  formatBibleError,
};
