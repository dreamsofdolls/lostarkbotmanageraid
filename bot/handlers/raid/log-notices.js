"use strict";

/**
 * bot/handlers/raid/log-notices.js
 * Notice cards for /raid-log: one per error code, and the lock card that
 * replaces a panel whose character stopped sharing logs.
 */

const { t } = require("../../services/i18n");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");

const NOTICE_TYPES = Object.freeze({
  owner_only: "lock", panel_busy: "info", stale: "info", invalid_selection: "warn", expired: "muted",
  busy: "warn", invalid_source: "warn", invalid_character: "warn", roster_changed: "warn",
  character_not_found: "warn", no_logs: "info", logs_private: "lock", character_mismatch: "error",
  rate_limited: "warn", timeout: "error", unavailable: "error", incomplete: "error", too_large: "warn",
  browser_crashed: "error", browser_unavailable: "error", invalid_url: "error", invalid_view: "error", failed: "error",
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
    type: NOTICE_TYPES[code], title: t(`raid-log.notices.${code}.title`, lang), description: lines.join("\n"),
  });
}

/**
 * The card left on a panel whose log access ended mid-session.
 * @param {string} code logs_private, no_logs or character_mismatch
 * @param {{ EmbedBuilder: Function, lang: string, character: string }} context
 * @returns {import("discord.js").EmbedBuilder}
 */
function buildRevokedNotice(code, { EmbedBuilder, lang, character }) {
  if (code !== "logs_private") {
    return buildNoticeEmbed(EmbedBuilder, {
      type: "lock", title: t(`raid-log.notices.${code}.title`, lang), description: t(`raid-log.notices.${code}.description`, lang),
    });
  }
  return buildNoticeEmbed(EmbedBuilder, {
    type: "lock", title: t("raid-log.notices.revoked.title", lang, { character }),
    description: `${t("raid-log.notices.revoked.description", lang, { character })}\n-# ${t("raid-log.notices.revoked.hint", lang)}`,
  });
}

module.exports = { buildRaidLogNotice, buildRevokedNotice };
