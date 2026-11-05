"use strict";

const { tPick } = require("../../../services/i18n");
const { NoticeKind } = require("../../../utils/raid/common/shared");

const MANUAL_SYNC_FOLLOWUP = Object.freeze({
  applied: {
    kind: NoticeKind.DONE,
    titleKey: "raid-status.sync.followupSuccessTitle",
    descriptionKey: "raid-status.sync.followupApplied",
    vars: (outcome) => ({ n: outcome.newGatesApplied || 0 }),
  },
  "synced-no-new": {
    kind: NoticeKind.EMPTY,
    titleKey: "raid-status.sync.followupNeutralTitle",
    descriptionKey: "raid-status.sync.followupSyncedNoNew",
  },
  failed: {
    kind: NoticeKind.BUSY,
    titleKey: "raid-status.sync.followupFailedTitle",
    descriptionKey: "raid-status.sync.followupFailedDescription",
    tipKey: "raid-status.sync.followupFailedTip",
  },
});

// tPick, not t: the success and no-new bodies are variant pools, so a user
// syncing several times a week does not read the same sentence each time.
/**
 * Follow-up notice after a manual /raid-status sync.
 * @param {{outcome?: string, newGatesApplied?: number}|null} manualOutcome
 * @param {string} lang
 * @param {Function} [translate=tPick] - injectable for tests
 * @returns {{kind: string, title: string, description: string, tip?: string}|null}
 *   null for an outcome that gets no follow-up
 */
function buildManualSyncFollowupPayload(manualOutcome, lang, translate = tPick) {
  const spec = MANUAL_SYNC_FOLLOWUP[String(manualOutcome?.outcome || "")];
  if (!spec) return null;
  const vars = typeof spec.vars === "function" ? spec.vars(manualOutcome || {}) : undefined;
  return {
    kind: spec.kind,
    title: translate(spec.titleKey, lang),
    description: translate(spec.descriptionKey, lang, vars),
    ...(spec.tipKey && { tip: translate(spec.tipKey, lang) }),
  };
}

module.exports = {
  buildManualSyncFollowupPayload,
};
