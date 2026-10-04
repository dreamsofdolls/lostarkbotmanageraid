"use strict";

const { t } = require("../../../../services/i18n");

/**
 * One promotion line per signup moved off the waitlist. Shared by the RSVP
 * follow-up and the kick board post so the wording cannot drift apart.
 * @param {object[]} promoted - detectPromotion() result
 * @param {string} lang - the board's language
 * @returns {string|null} the ping content, or null when nobody was promoted
 */
function buildPromotedPingContent(promoted, lang) {
  if (promoted.length === 0) return null;
  return promoted
    .map((s) => t("raid-schedule.notice.promotedPing", lang, {
      user: `<@${s.discordId}>`,
      character: s.characterName,
    }))
    .join("\n");
}

module.exports = {
  buildPromotedPingContent,
};
