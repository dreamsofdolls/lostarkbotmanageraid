"use strict";

/**
 * handlers/local-sync/discord-console-card.js
 * What a Local Sync card says for one preview job: the step of
 * read > preview > sync it stands on, the sentence under it, the side
 * colour, and which parts of the card are shown. No discord.js in here,
 * so the state table is testable without building an embed.
 */

const { t } = require("../../services/i18n");
const { COMPANION_SCOPE } = require("../../services/local-sync");

const RETRYABLE_PENDING_REASONS = new Set([
  "sync_busy",
  "write_error",
  "party_write_error",
  "apply_failed",
]);
const PARTY_RETRY_REASON = "party_write_error";
const JOB_KINDS = new Set([
  "pending",
  "applying",
  "applied",
  "cancelled",
  "superseded",
  "expired",
  "failed",
]);
const BODY_KINDS = new Set(["pending", "retry", "applying", "applied"]);
const ACTIONABLE_KINDS = new Set(["pending", "retry"]);

// Yellow asks for another Sync, grey marks a card with nothing left to do
// and red is a failure another Sync cannot fix. Every other kind is neutral.
const COLOR_KEY_BY_KIND = Object.freeze({
  retry: "progress",
  applied: "success",
  cancelled: "muted",
  superseded: "muted",
  expired: "muted",
  disabled: "muted",
  failed: "danger",
});
const MIDDLE_STEP_BY_KIND = Object.freeze({
  nothing: ["ℹ️", "nothing"],
  cancelled: ["✖️", "cancelled"],
  superseded: ["🔁", "superseded"],
  expired: ["⌛", "expired"],
});
const LAST_STEP_BY_KIND = Object.freeze({
  applying: ["🔄", "applying"],
  applied: ["✅", "applied"],
  failed: ["⚠️", "failed"],
});
const RETRY_STEP_BY_REASON = Object.freeze({
  sync_busy: ["⏳", "busy"],
  apply_failed: ["⚠️", "tempError"],
});
const PARTIAL_STEP = ["⚠️", "partial"];
const FAILED_DESCRIPTION_BY_REASON = Object.freeze({
  local_sync_disabled: "failedLocalOff",
  auto_sync_disabled: "failedBibleOff",
});

function resolveCardKind({ job, state, summary, activeScope }) {
  if (!activeScope) return { kind: "disabled", retryReason: "" };
  if (!job) return { kind: "empty", retryReason: "" };
  if (state === "pending") {
    const failureReason = String(job.failureReason || "");
    if (RETRYABLE_PENDING_REASONS.has(failureReason)) {
      return { kind: "retry", retryReason: failureReason };
    }
    // A lease that lapsed after party authorization leaves the owner's gates
    // written and the party's pending, and only another Sync finishes them.
    if (job.partyAuthorized === true) return { kind: "retry", retryReason: PARTY_RETRY_REASON };
    if (Number(summary?.changes?.gates) === 0) return { kind: "nothing", retryReason: "" };
  }
  return { kind: JOB_KINDS.has(state) ? state : "missing", retryReason: "" };
}

function buildTrackerLine(kind, retryReason, lang) {
  const step = (icon, key, current = false) => {
    const label = t(`local-sync-discord.tracker.${key}`, lang);
    return `${icon} ${current ? `**${label}**` : label}`;
  };
  const join = (...steps) => steps.join(" › ");

  if (kind === "empty") return join(step("⏳", "read", true), step("⚪", "preview"), step("⚪", "sync"));
  if (kind === "pending") return join(step("✅", "read"), step("⏳", "preview", true), step("⚪", "sync"));

  const middleStep = MIDDLE_STEP_BY_KIND[kind];
  if (middleStep) return join(step("✅", "read"), step(...middleStep, true), step("⚪", "sync"));

  const lastStep = kind === "retry"
    ? RETRY_STEP_BY_REASON[retryReason] || PARTIAL_STEP
    : LAST_STEP_BY_KIND[kind];
  if (!lastStep) return "";
  return join(step("✅", "read"), step("✅", "preview"), step(...lastStep, true));
}

// Which reader control the card offers: its own link, the Solo button that
// /raid-status adds for Bible Auto-sync viewers, or neither when the server
// has no public URL.
function resolveReaderAccess({ hasReaderLink, activeScope }) {
  if (hasReaderLink) return "link";
  return activeScope === COMPANION_SCOPE.solo ? "solo" : "none";
}

function buildCardSentence({ kind, retryReason, job, readerAccess, lang }) {
  const describe = (key, vars = null) => t(`local-sync-discord.stateDescriptions.${key}`, lang, vars);
  if (kind === "disabled") return t("local-sync-discord.disabledDescription", lang);
  if (kind === "empty") {
    return t("local-sync-discord.noPreviewDescription", lang, {
      openReader: t(`local-sync-discord.noPreviewOpen.${readerAccess}`, lang),
    }).join("\n");
  }
  if (kind === "retry") return t(`local-sync-discord.retryReasons.${retryReason}`, lang);
  if (kind === "applied") {
    const rejected = job.result?.rejected?.length || 0;
    return rejected > 0 ? describe("appliedWithRejected", { rejected }) : describe("applied");
  }

  const reader = t(`local-sync-discord.readerAction.${readerAccess}`, lang);
  if (kind === "expired") return describe("expired", { reader });
  if (kind === "failed") {
    const reasonKey = FAILED_DESCRIPTION_BY_REASON[job.failureReason];
    return reasonKey ? describe(reasonKey, { reader }) : describe("failed");
  }
  return describe(kind);
}

/**
 * Decide what a Local Sync card shows for one preview job.
 * @param {object} options
 * @param {object|null} options.job - stored preview job, null when none exists
 * @param {string} options.state - resolvePreviewJobState(job), ignored without a job
 * @param {object|null} options.summary - projected change summary; its changes.gates decides "nothing new"
 * @param {string|null} options.activeScope - COMPANION_SCOPE value, null when no sync mode is on
 * @param {boolean} options.hasReaderLink - whether the card carries the Local Reader link button
 * @param {string} options.lang
 * @returns {{kind: string, colorKey: string, showBody: boolean, showApplyCancel: boolean, showExpiry: boolean, trackerLine: string, sentence: string}}
 */
function describeLocalSyncCard({ job, state, summary, activeScope, hasReaderLink, lang }) {
  const { kind, retryReason } = resolveCardKind({ job, state, summary, activeScope });
  const actionable = ACTIONABLE_KINDS.has(kind);
  return {
    kind,
    colorKey: COLOR_KEY_BY_KIND[kind] || "neutral",
    // An unknown gate count still lists what the job carries; only a known
    // zero means there is nothing to show.
    showBody: BODY_KINDS.has(kind) && Number(summary?.changes?.gates) !== 0,
    showApplyCancel: actionable,
    showExpiry: actionable,
    trackerLine: buildTrackerLine(kind, retryReason, lang),
    sentence: buildCardSentence({
      kind,
      retryReason,
      job,
      readerAccess: resolveReaderAccess({ hasReaderLink, activeScope }),
      lang,
    }),
  };
}

module.exports = {
  describeLocalSyncCard,
};
