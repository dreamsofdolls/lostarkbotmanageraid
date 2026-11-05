/**
 * handlers/raid/bg/notices.js
 * The /raid-bg notices shared by `set`, `edit` and `view`: an upload the
 * pipeline refused, a library write that failed, and an empty library.
 * Each returns buildNoticeEmbed options.
 */

"use strict";

const { t } = require("../../../services/i18n");
const { NoticeKind, buildDetailField } = require("../../../utils/raid/common/shared");
const {
  RAID_BG_UPLOAD_MAX_MB,
  RAID_BG_MIN_WIDTH,
  RAID_BG_MIN_HEIGHT,
  RAID_BG_MAX_PIXELS,
} = require("./image-pipeline");

// Pipeline errors about the image itself; any other RaidBgError (a download
// that did not complete) is a failure on the bot's side.
const VALIDATION_ERROR_KEYS = new Set([
  "raidBg.errors.sizeTooBig",
  "raidBg.errors.formatUnsupported",
  "raidBg.errors.decodeFailed",
  "raidBg.errors.tooSmall",
  "raidBg.errors.tooLarge",
]);

function buildRequirementsField(lang) {
  return {
    name: t("raidBg.set.requirementsHeader", lang),
    value: t("raidBg.set.requirementsLines", lang, {
      minW: RAID_BG_MIN_WIDTH,
      minH: RAID_BG_MIN_HEIGHT,
      maxMp: RAID_BG_MAX_PIXELS / 1_000_000,
      maxMb: RAID_BG_UPLOAD_MAX_MB.toFixed(0),
    }),
    inline: false,
  };
}

/**
 * The notice for an upload the image pipeline refused. A rejected image is
 * input, with the limits listed and the decoder's own message (if any) in
 * the detail field; a failed download is a failure.
 * @param {{key: string, params?: object}} err - a RaidBgError
 * @param {string} [lang]
 * @returns {object} buildNoticeEmbed options
 */
function buildUploadErrorNotice(err, lang) {
  if (!VALIDATION_ERROR_KEYS.has(err.key)) {
    return {
      kind: NoticeKind.FAILURE,
      title: t("raidBg.set.downloadFailedTitle", lang),
      description: t(err.key, lang, err.params),
      tip: t("raidBg.set.downloadFailedTip", lang),
    };
  }
  return {
    kind: NoticeKind.INPUT,
    title: t("raidBg.set.rejectTitle", lang),
    description: t(err.key, lang, err.params),
    fields: [buildRequirementsField(lang), buildDetailField(err.params?.message, lang)],
    tip: t("raidBg.set.rejectTip", lang),
  };
}

/**
 * The notice for a library write that did not persist.
 * @param {unknown} err - the error the write threw
 * @param {string} [lang]
 * @returns {object} buildNoticeEmbed options
 */
function buildSaveFailedNotice(err, lang) {
  return {
    kind: NoticeKind.FAILURE,
    title: t("raidBg.set.saveFailedTitle", lang),
    description: t("raidBg.errors.storageFailed", lang),
    fields: [buildDetailField(err?.message || String(err), lang)],
    tip: t("raidBg.set.saveFailedTip", lang),
  };
}

/**
 * The notice `edit` and `view` show when the user has no saved scene.
 * @param {string} [lang]
 * @returns {object} buildNoticeEmbed options
 */
function buildNoLibraryNotice(lang) {
  return {
    kind: NoticeKind.EMPTY,
    title: t("raidBg.noLibraryTitle", lang),
    description: t("raidBg.noLibraryDescription", lang),
    tip: t("raidBg.noLibraryTip", lang),
  };
}

module.exports = {
  buildNoLibraryNotice,
  buildSaveFailedNotice,
  buildUploadErrorNotice,
};
