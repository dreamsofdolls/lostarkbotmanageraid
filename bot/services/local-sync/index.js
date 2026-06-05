/**
 * services/local-sync/index.js
 * Aggregate re-export surface for the local-sync sub-package. Callers
 * import via `require("./local-sync")` rather than spelunking into
 * sub-modules · keeps the dependency graph greppable and lets us
 * relocate internals without touching consumers.
 */

"use strict";

// Local-sync mode entry point. Future phases add sub-modules here:
//   - state.js (Phase 1, this commit) - mutex helpers + status snapshot
//   - tokens.js (Phase 4) - JWT mint/verify for the web-companion link
//   - apply.js (Phase 4) - dedupe + apply incoming raid-clear deltas
//
// Re-exports stay explicit so a `require("./local-sync")` import surface
// is greppable from any caller without spelunking through sub-modules.

const state = require("./core/state");
const tokens = require("./core/tokens");
const apply = require("./core/apply");
const profileDeviceToken = require("./profile/device-token");

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
  extractProfileFromUser: tokens.extractProfileFromUser,
  TOKEN_DEFAULT_TTL_SEC: tokens.DEFAULT_TTL_SEC,
  TOKEN_POST_SYNC_TTL_SEC: tokens.POST_SYNC_TTL_SEC,
  rotateLocalProfileSyncToken: profileDeviceToken.rotateLocalProfileSyncToken,
  isCurrentProfileDeviceToken: profileDeviceToken.isCurrentProfileDeviceToken,
  hashProfileDeviceToken: profileDeviceToken.hashProfileDeviceToken,
  PROFILE_DEVICE_TTL_SEC: profileDeviceToken.DEFAULT_PROFILE_DEVICE_TTL_SEC,
  applyLocalSyncDeltas: apply.applyLocalSyncDeltas,
  resolveLocalSyncTarget: apply.resolveTarget,
  bucketizeLocalSyncDeltas: apply.bucketize,
  normalizeLocalSyncDifficulty: apply.normalizeDifficulty,
};
