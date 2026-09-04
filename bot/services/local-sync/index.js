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
const accessUrl = require("./core/access-url");
const apply = require("./core/apply/apply");
const scope = require("./core/scope");
const previewJobs = require("./core/preview-jobs");
const applyPreview = require("./core/apply-preview-job");
const partyPropagation = require("./core/party-propagation");

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
  publicBaseUrl: accessUrl.publicBaseUrl,
  buildLocalSyncUrl: accessUrl.buildLocalSyncUrl,
  issueLocalSyncAccessUrl: accessUrl.issueLocalSyncAccessUrl,
  TOKEN_DEFAULT_TTL_SEC: tokens.DEFAULT_TTL_SEC,
  TOKEN_POST_SYNC_TTL_SEC: tokens.POST_SYNC_TTL_SEC,
  COMPANION_SCOPE: scope.COMPANION_SCOPE,
  getTokenCompanionScope: scope.getTokenCompanionScope,
  isCompanionScopeEnabledForUser: scope.isCompanionScopeEnabledForUser,
  isModeAllowedForCompanionScope: scope.isModeAllowedForCompanionScope,
  applyLocalSyncDeltas: apply.applyLocalSyncDeltas,
  resolveLocalSyncTarget: apply.resolveTarget,
  bucketizeLocalSyncDeltas: apply.bucketize,
  normalizeLocalSyncDifficulty: apply.normalizeDifficulty,
  PREVIEW_APPLY_LEASE_MS: previewJobs.PREVIEW_APPLY_LEASE_MS,
  normalizePreviewDeltas: previewJobs.normalizePreviewDeltas,
  filterPartyDeltasBySourceDeltas: previewJobs.filterPartyDeltasBySourceDeltas,
  resolvePreviewJobState: previewJobs.resolveJobState,
  createPreviewJob: previewJobs.createPreviewJob,
  getPreviewJob: previewJobs.getPreviewJob,
  getLatestPreviewJob: previewJobs.getLatestPreviewJob,
  cancelPreviewJob: previewJobs.cancelPreviewJob,
  recordPreviewDelivery: previewJobs.recordPreviewDelivery,
  applyPreviewJob: applyPreview.applyPreviewJob,
  propagatePartyDeltas: partyPropagation.propagatePartyDeltas,
};
