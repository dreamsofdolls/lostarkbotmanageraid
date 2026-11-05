"use strict";

/**
 * bot/handlers/raid/log-notices.js
 * Notice cards for /raid-log: one per error code, and the lock card that
 * replaces a panel whose character stopped sharing logs.
 */

const { t } = require("../../services/i18n");
const { NoticeKind, buildNoticeEmbed, formatCharacterLabel } = require("../../utils/raid/common/shared");

// The kind of each code; its copy is `raid-log.notices.<code>.title|description|tip`.
// Unknown errors already arrive as `failed` (services/raid-log/errors.js).
const NOTICE_KINDS = Object.freeze({
  owner_only: NoticeKind.GUARD, panel_busy: NoticeKind.BUSY, stale: NoticeKind.EXPIRED,
  invalid_selection: NoticeKind.EXPIRED, expired: NoticeKind.EXPIRED, busy: NoticeKind.BUSY,
  invalid_source: NoticeKind.INPUT, invalid_character: NoticeKind.INPUT, roster_changed: NoticeKind.EXPIRED,
  character_not_found: NoticeKind.EMPTY, no_logs: NoticeKind.EMPTY, logs_private: NoticeKind.GUARD,
  character_mismatch: NoticeKind.FAILURE, rate_limited: NoticeKind.BUSY, timeout: NoticeKind.BUSY,
  unavailable: NoticeKind.FAILURE, incomplete: NoticeKind.FAILURE, too_large: NoticeKind.BUSY,
  browser_crashed: NoticeKind.FAILURE, browser_unavailable: NoticeKind.FAILURE, invalid_url: NoticeKind.INPUT,
  invalid_view: NoticeKind.FAILURE, failed: NoticeKind.FAILURE,
});
// Failures of a log that exists on Bible; the original page is still worth opening.
const LINKED_CODES = new Set(["timeout", "unavailable", "incomplete", "too_large", "browser_crashed", "failed"]);

/**
 * @param {string} code raid-log error code
 * @param {{ EmbedBuilder: Function, lang: string, logUrl?: string, owner?: string }} context
 *   `logUrl` is the log being opened; `owner` the panel owner's mention
 * @returns {import("discord.js").EmbedBuilder}
 */
function buildRaidLogNotice(code, { EmbedBuilder, lang, logUrl, owner }) {
  const lines = [t(`raid-log.notices.${code}.description`, lang, { owner })];
  if (logUrl && LINKED_CODES.has(code)) lines.push(t("raid-log.notices.link", lang, { url: logUrl }));
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NOTICE_KINDS[code],
    title: t(`raid-log.notices.${code}.title`, lang),
    description: lines.join("\n"),
    tip: t(`raid-log.notices.${code}.tip`, lang),
  });
}

/**
 * The card left on a panel whose log access ended mid-session: the code's
 * own notice, or for a character that went private a guard naming it. The
 * title keeps the plain name; the sentence shows it with its class icon.
 * @param {string} code logs_private, no_logs or character_mismatch
 * @param {{ EmbedBuilder: Function, lang: string, character: string, className?: string }} context
 * @returns {import("discord.js").EmbedBuilder}
 */
function buildRevokedNotice(code, { EmbedBuilder, lang, character, className }) {
  if (code !== "logs_private") return buildRaidLogNotice(code, { EmbedBuilder, lang });
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.GUARD,
    title: t("raid-log.notices.revoked.title", lang, { character }),
    description: t("raid-log.notices.revoked.description", lang, {
      character: formatCharacterLabel(character, className),
    }),
    tip: t("raid-log.notices.revoked.tip", lang),
  });
}

module.exports = { buildRaidLogNotice, buildRevokedNotice };
