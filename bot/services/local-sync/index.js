/**
 * services/local-sync/index.js
 * Aggregate re-export surface for the local-sync sub-package. Callers
 * import via `require("./local-sync")` rather than spelunking into
 * sub-modules; this keeps the dependency graph greppable and lets us
 * relocate internals without touching consumers.
 */

"use strict";

// Re-exports stay explicit so callers have one stable, greppable facade
// for mode state, signed tokens, scope policy, and delta application.

const state = require("./core/state");
const tokens = require("./core/tokens");
const apply = require("./core/apply/apply");
const scope = require("./core/scope");
const previewJobs = require("./core/preview-jobs");
const applyPreview = require("./core/apply-preview-job");

module.exports = {
  SYNC_MODE: state.SYNC_MODE,
  RESULT: state.RESULT,
  setLocalSyncEnabled: state.setLocalSyncEnabled,
  setBibleAutoSyncEnabled: state.setBibleAutoSyncEnabled,
  resolveSyncMode: state.resolveSyncMode,
  getSyncStatus: state.getSyncStatus,
  recordLocalSyncSuccess: state.recordLocalSyncSuccess,
  mintToken: tokens.mintToken,
  verifyToken: tokens.verifyToken,
  isCurrentStoredToken: tokens.isCurrentStoredToken,
  rotateLocalSyncToken: tokens.rotateLocalSyncToken,
  getOrMintLocalSyncToken: tokens.getOrMintLocalSyncToken,
  extractIdentityFromUser: tokens.extractIdentityFromUser,
  TOKEN_DEFAULT_TTL_SEC: tokens.DEFAULT_TTL_SEC,
  TOKEN_POST_SYNC_TTL_SEC: tokens.POST_SYNC_TTL_SEC,
  COMPANION_SCOPE: scope.COMPANION_SCOPE,
  SCOPE_NOT_ALLOWED_REASON: scope.SCOPE_NOT_ALLOWED_REASON,
  normalizeCompanionScope: scope.normalizeCompanionScope,
  getTokenCompanionScope: scope.getTokenCompanionScope,
  isCompanionScopeEnabledForUser: scope.isCompanionScopeEnabledForUser,
  isModeAllowedForCompanionScope: scope.isModeAllowedForCompanionScope,
  resolveRequiredCompanionScope: scope.resolveRequiredCompanionScope,
  buildCompanionStateFilter: scope.buildCompanionStateFilter,
  applyLocalSyncDeltas: apply.applyLocalSyncDeltas,
  resolveLocalSyncTarget: apply.resolveTarget,
  bucketizeLocalSyncDeltas: apply.bucketize,
  normalizeLocalSyncDifficulty: apply.normalizeDifficulty,
  PREVIEW_JOB_TTL_MS: previewJobs.PREVIEW_JOB_TTL_MS,
  PREVIEW_APPLY_LEASE_MS: previewJobs.PREVIEW_APPLY_LEASE_MS,
  MAX_PREVIEW_DELTAS: previewJobs.MAX_PREVIEW_DELTAS,
  normalizePreviewDeltas: previewJobs.normalizePreviewDeltas,
  fingerprintLocalSyncToken: previewJobs.fingerprintToken,
  resolvePreviewJobState: previewJobs.resolveJobState,
  createPreviewJob: previewJobs.createPreviewJob,
  getPreviewJob: previewJobs.getPreviewJob,
  getPreviewJobForUser: previewJobs.getPreviewJobForUser,
  getLatestPreviewJob: previewJobs.getLatestPreviewJob,
  claimPreviewJob: previewJobs.claimPreviewJob,
  releasePreviewJob: previewJobs.releasePreviewJob,
  finishPreviewJob: previewJobs.finishPreviewJob,
  failPreviewJob: previewJobs.failPreviewJob,
  cancelPreviewJob: previewJobs.cancelPreviewJob,
  recordPreviewDelivery: previewJobs.recordPreviewDelivery,
  applyPreviewJob: applyPreview.applyPreviewJob,
};
