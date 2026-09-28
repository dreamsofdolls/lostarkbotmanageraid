"use strict";

const { tPick } = require("../i18n");

/**
 * How a manual roster refresh reads to the person who pressed it:
 * "updated" when Bible returned a changed roster, "noUpdate" when the refresh
 * ran (or was skipped) without changing it, "missing" for anything else
 * (no such user or roster).
 * @param {{status?: string}|null} result - runManualRosterRefresh's result
 * @returns {"updated"|"noUpdate"|"missing"}
 */
function rosterRefreshOutcome(result) {
  if (result?.status === "updated") return "updated";
  if (result?.status === "attempted" || result?.status === "skipped") return "noUpdate";
  return "missing";
}

/**
 * The notice a surface shows after a manual roster refresh.
 * @param {object} result - runManualRosterRefresh's result
 * @param {string} lang
 * @param {Record<"updated"|"noUpdate"|"missing", {type: string, title: string, description: string}>} notices
 *   the surface's notice type and translation keys per outcome (titles may be variant pools)
 * @param {object} vars - description variables
 * @returns {{type: string, title: string, description: string}}
 */
function buildRosterRefreshNotice(result, lang, notices, vars) {
  const notice = notices[rosterRefreshOutcome(result)];
  return {
    type: notice.type,
    title: tPick(notice.title, lang),
    description: tPick(notice.description, lang, vars),
  };
}

module.exports = {
  rosterRefreshOutcome,
  buildRosterRefreshNotice,
};
