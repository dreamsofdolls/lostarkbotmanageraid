"use strict";

const User = require("../../../models/user");
const LocalSyncPreview = require("../../../models/localSyncPreview");
const { getRaidRequirementMap } = require("../../../models/Raid");
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

async function applyPreviewJob(jobId, discordId, deps = {}) {
  const UserModel = deps.UserModel || User;
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const modelDeps = previewDeps(PreviewModel);
  const claimedDoc = await claimPreviewJob(jobId, discordId, modelDeps);
  if (!claimedDoc) {
    const existing = await getPreviewJobForUser(jobId, discordId, modelDeps);
    return {
      ok: false,
      state: resolveJobState(existing),
      job: existing || null,
    };
  }

  const job = typeof claimedDoc.toObject === "function"
    ? claimedDoc.toObject()
    : claimedDoc;
  const leaseDeps = {
    ...modelDeps,
    leaseStartedAt: job.applyingAt,
  };
  let ownsSyncSlot = false;

  try {
    const userDoc = await loadApplyUser(discordId, UserModel);
    if (!isCompanionScopeEnabledForUser(userDoc, job.scope)) {
      const failed = await failPreviewJob(
        jobId,
        discordId,
        job.scope === COMPANION_SCOPE.solo ? "auto_sync_disabled" : "local_sync_disabled",
        null,
        leaseDeps
      );
      return { ok: false, state: "failed", job: failed || job };
    }

    if (
      job.scope === COMPANION_SCOPE.solo
      && typeof deps.acquireAutoManageSyncSlot === "function"
      && typeof deps.releaseAutoManageSyncSlot === "function"
    ) {
      const guard = await deps.acquireAutoManageSyncSlot(discordId, { ignoreCooldown: true });
      if (!guard?.acquired) {
        const released = await releasePreviewJob(jobId, discordId, "sync_busy", leaseDeps);
        return { ok: false, state: "busy", job: released || job };
      }
      ownsSyncSlot = true;
    }

    const summary = await applyLocalSyncDeltas(discordId, job.deltas || [], {
      applyRaidSetForDiscordId: deps.applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId: deps.applyRaidSetBatchForDiscordId || null,
      getRaidRequirementMap: deps.getRaidRequirementMap || getRaidRequirementMap,
      userDoc,
      requireLocalSyncEnabled: job.scope === COMPANION_SCOPE.full,
      requiredCompanionScope: job.scope,
    });

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

    if (hasWriteError(summary)) {
      // A retry is safe: successful writes are retained and roster preflight
      // will skip them, while only the failed writes remain actionable.
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

    try {
      await recordLocalSyncSuccess(discordId, {
        UserModel,
        scope: job.scope,
      });
    } catch (err) {
      console.warn("[local-sync/preview-job] timestamp stamp failed:", err?.message || err);
    }

    let newExpSec = null;
    if (Array.isArray(summary.applied) && summary.applied.length > 0) {
      try {
        newExpSec = await shrinkSourceTokenAfterWrite({
          UserModel,
          userDoc,
          job,
          discordId,
        });
      } catch (err) {
        console.warn("[local-sync/preview-job] token shrink failed:", err?.message || err);
      }
    }

    const result = { ...summary, newExpSec };
    const finished = await finishPreviewJob(jobId, discordId, result, leaseDeps);
    if (!finished) {
      const existing = await getPreviewJobForUser(jobId, discordId, modelDeps);
      const state = resolveJobState(existing);
      return {
        ok: state === "applied",
        state,
        job: existing || null,
        result,
      };
    }
    return {
      ok: true,
      state: "applied",
      job: finished,
      result,
    };
  } catch (err) {
    console.warn("[local-sync/preview-job] apply failed:", err?.message || err);
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
  } finally {
    if (ownsSyncSlot && typeof deps.releaseAutoManageSyncSlot === "function") {
      try {
        await deps.releaseAutoManageSyncSlot(discordId);
      } catch (err) {
        console.warn("[local-sync/preview-job] sync slot release failed:", err?.message || err);
      }
    }
  }
}

module.exports = {
  applyPreviewJob,
  findDisabledWrite,
  hasWriteError,
  shrinkSourceTokenAfterWrite,
};
