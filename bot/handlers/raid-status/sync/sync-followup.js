"use strict";

const { tPick } = require("../../../services/i18n");

const MANUAL_SYNC_FOLLOWUP = Object.freeze({
  applied: {
    type: "success",
    titleKey: "raid-status.sync.followupSuccessTitle",
    descriptionKey: "raid-status.sync.followupApplied",
    vars: (outcome) => ({ n: outcome.newGatesApplied || 0 }),
  },
  "synced-no-new": {
    type: "info",
    titleKey: "raid-status.sync.followupNeutralTitle",
    descriptionKey: "raid-status.sync.followupSyncedNoNew",
  },
  failed: {
    type: "warn",
    titleKey: "raid-status.sync.followupFailedTitle",
    descriptionKey: "raid-status.sync.followupFailedDescription",
  },
});

// tPick, not t: the success/neutral titles and bodies are variant pools, so a
// user syncing several times a week does not read the same sentence each time.
function buildManualSyncFollowupPayload(manualOutcome, lang, translate = tPick) {
  const spec = MANUAL_SYNC_FOLLOWUP[String(manualOutcome?.outcome || "")];
  if (!spec) return null;
  const vars = typeof spec.vars === "function" ? spec.vars(manualOutcome || {}) : undefined;
  return {
    type: spec.type,
    title: translate(spec.titleKey, lang),
    description: translate(spec.descriptionKey, lang, vars),
  };
}

module.exports = {
  buildManualSyncFollowupPayload,
};
