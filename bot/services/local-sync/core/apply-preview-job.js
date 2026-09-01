"use strict";

const User = require("../../../models/user");
const LocalSyncPreview = require("../../../models/localSyncPreview");
const { getRaidRequirementMap } = require("../../../domain/raid-catalog");
const {
  COMPANION_SCOPE,
  isCompanionScopeEnabledForUser,
} = require("./scope");
const { applyLocalSyncDeltas } = require("./apply/apply");
const { recordLocalSyncSuccess } = require("./state");
const { POST_SYNC_TTL_SEC } = require("./tokens");
const {
  fingerprintToken,
  resolveJobState,
  claimPreviewJob,
  releasePreviewJob,
  finishPreviewJob,
  failPreviewJob,
  getPreviewJobForUser,
} = require("./preview-jobs");

function previewDeps(PreviewModel) {
  return PreviewModel ? { PreviewModel } : {};
}

async function loadApplyUser(discordId, UserModel) {
  return UserModel.findOne({ discordId })
    .select(
      "autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt " +
      "accounts.accountName accounts.characters.name accounts.characters.class " +
      "accounts.characters.itemLevel accounts.characters.isGoldEarner accounts.characters.assignedRaids"
    )
    .lean();
}

function findDisabledWrite(summary) {
  return (summary?.rejected || []).find((item) =>
    item?.reason === "local_sync_disabled" || item?.reason === "auto_sync_disabled"
  );
}

function hasWriteError(summary) {
  return (summary?.rejected || []).some((item) => item?.reason === "write_error");
}

async function shrinkSourceTokenAfterWrite({ UserModel, userDoc, job, discordId }) {
  const currentToken = userDoc?.lastLocalSyncToken;
  if (!currentToken || !job?.tokenFingerprint) return null;
  if (fingerprintToken(currentToken) !== job.tokenFingerprint) return null;
  const newExpSec = Math.floor(Date.now() / 1000) + POST_SYNC_TTL_SEC;
  const result = await UserModel.updateOne(
    { discordId, lastLocalSyncToken: currentToken },
    { $set: { lastLocalSyncTokenExpAt: newExpSec } }
  );
  const matched = Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? 0);
  return matched > 0 ? newExpSec : null;
}

async function claimApplyContext(jobId, discordId, modelDeps) {
  const claimedDoc = await claimPreviewJob(jobId, discordId, modelDeps);
  if (claimedDoc) {
    const job = typeof claimedDoc.toObject === "function"
      ? claimedDoc.toObject()
      : claimedDoc;
    return {
      job,
      leaseDeps: { ...modelDeps, leaseStartedAt: job.applyingAt },
      outcome: null,
    };
  }
  const existing = await getPreviewJobForUser(jobId, discordId, modelDeps);
  return {
    job: null,
    leaseDeps: null,
    outcome: {
      ok: false,
      state: resolveJobState(existing),
      job: existing || null,
    },
  };
}

async function rejectDisabledCompanionScope({
  jobId,
  discordId,
  job,
  userDoc,
  leaseDeps,
}) {
  if (isCompanionScopeEnabledForUser(userDoc, job.scope)) return null;
  const reason = job.scope === COMPANION_SCOPE.solo
    ? "auto_sync_disabled"
    : "local_sync_disabled";
  const failed = await failPreviewJob(jobId, discordId, reason, null, leaseDeps);
  return { ok: false, state: "failed", job: failed || job };
}

function supportsAutoManageSlot(deps) {
  return typeof deps.acquireAutoManageSyncSlot === "function"
    && typeof deps.releaseAutoManageSyncSlot === "function";
}

async function acquireApplySlot({ jobId, discordId, job, leaseDeps, deps }) {
  if (job.scope !== COMPANION_SCOPE.solo || !supportsAutoManageSlot(deps)) {
    return { ownsSlot: false, outcome: null };
  }
  const guard = await deps.acquireAutoManageSyncSlot(discordId, { ignoreCooldown: true });
  if (guard?.acquired) return { ownsSlot: true, outcome: null };
  const released = await releasePreviewJob(jobId, discordId, "sync_busy", leaseDeps);
  return {
    ownsSlot: false,
    outcome: { ok: false, state: "busy", job: released || job },
  };
}

function buildApplyDeltaOptions(job, userDoc, deps) {
  return {
    applyRaidSetForDiscordId: deps.applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId: deps.applyRaidSetBatchForDiscordId || null,
    getRaidRequirementMap: deps.getRaidRequirementMap || getRaidRequirementMap,
    userDoc,
    requireLocalSyncEnabled: job.scope === COMPANION_SCOPE.full,
    requiredCompanionScope: job.scope,
  };
}

async function resolveRejectedSummary({
  jobId,
  discordId,
  job,
  summary,
  leaseDeps,
}) {
  const disabledWrite = findDisabledWrite(summary);
  if (disabledWrite) {
    const failed = await failPreviewJob(
      jobId,
      discordId,
      disabledWrite.reason,
      summary,
      leaseDeps
    );
    return { ok: false, state: "failed", job: failed || job, result: summary };
  }
  if (!hasWriteError(summary)) return null;

  const released = await releasePreviewJob(
    jobId,
    discordId,
    "write_error",
    leaseDeps,
    { result: summary, clearProjection: true }
  );
  return {
    ok: false,
    state: "pending",
    retryable: true,
    job: released || job,
    result: summary,
  };
}

async function recordPreviewSuccessBestEffort(discordId, UserModel, scope) {
  try {
    await recordLocalSyncSuccess(discordId, { UserModel, scope });
  } catch (err) {
    console.warn("[local-sync/preview-job] timestamp stamp failed:", err?.message || err);
  }
}

async function shrinkPreviewTokenBestEffort({ UserModel, userDoc, job, discordId, summary }) {
  if (!Array.isArray(summary.applied) || summary.applied.length === 0) return null;
  try {
    return await shrinkSourceTokenAfterWrite({ UserModel, userDoc, job, discordId });
  } catch (err) {
    console.warn("[local-sync/preview-job] token shrink failed:", err?.message || err);
    return null;
  }
}

async function finishAppliedPreview({
  jobId,
  discordId,
  summary,
  newExpSec,
  leaseDeps,
  modelDeps,
}) {
  const result = { ...summary, newExpSec };
  const finished = await finishPreviewJob(jobId, discordId, result, leaseDeps);
  if (finished) {
    return { ok: true, state: "applied", job: finished, result };
  }
  const existing = await getPreviewJobForUser(jobId, discordId, modelDeps);
  const state = resolveJobState(existing);
  return {
    ok: state === "applied",
    state,
    job: existing || null,
    result,
  };
}

async function recoverFailedPreviewApply({ jobId, discordId, job, leaseDeps, error }) {
  console.warn("[local-sync/preview-job] apply failed:", error?.message || error);
  const released = await releasePreviewJob(
    jobId,
    discordId,
    "apply_failed",
    leaseDeps
  ).catch(() => null);
  return {
    ok: false,
    state: released ? "pending" : "applying",
    retryable: Boolean(released),
    job: released || job,
  };
}

async function releaseApplySlotBestEffort(discordId, ownsSlot, deps) {
  if (!ownsSlot || typeof deps.releaseAutoManageSyncSlot !== "function") return;
  try {
    await deps.releaseAutoManageSyncSlot(discordId);
  } catch (err) {
    console.warn("[local-sync/preview-job] sync slot release failed:", err?.message || err);
  }
}

async function applyPreviewJob(jobId, discordId, deps = {}) {
  const UserModel = deps.UserModel || User;
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const modelDeps = previewDeps(PreviewModel);
  const claim = await claimApplyContext(jobId, discordId, modelDeps);
  if (claim.outcome) return claim.outcome;
  const { job, leaseDeps } = claim;
  let ownsSlot = false;

  try {
    const userDoc = await loadApplyUser(discordId, UserModel);
    const disabledOutcome = await rejectDisabledCompanionScope({
      jobId,
      discordId,
      job,
      userDoc,
      leaseDeps,
    });
    if (disabledOutcome) return disabledOutcome;

    const slot = await acquireApplySlot({ jobId, discordId, job, leaseDeps, deps });
    ownsSlot = slot.ownsSlot;
    if (slot.outcome) return slot.outcome;

    const summary = await applyLocalSyncDeltas(
      discordId,
      job.deltas || [],
      buildApplyDeltaOptions(job, userDoc, deps)
    );
    const rejectedOutcome = await resolveRejectedSummary({
      jobId,
      discordId,
      job,
      summary,
      leaseDeps,
    });
    if (rejectedOutcome) return rejectedOutcome;

    await recordPreviewSuccessBestEffort(discordId, UserModel, job.scope);
    const newExpSec = await shrinkPreviewTokenBestEffort({
      UserModel,
      userDoc,
      job,
      discordId,
      summary,
    });
    return finishAppliedPreview({
      jobId,
      discordId,
      summary,
      newExpSec,
      leaseDeps,
      modelDeps,
    });
  } catch (error) {
    return recoverFailedPreviewApply({ jobId, discordId, job, leaseDeps, error });
  } finally {
    await releaseApplySlotBestEffort(discordId, ownsSlot, deps);
  }
}

module.exports = {
  applyPreviewJob,
};
