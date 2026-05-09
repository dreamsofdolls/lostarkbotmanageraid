"use strict";

// Local-sync mode entry point. Future phases add sub-modules here:
//   - state.js (Phase 1, this commit) - mutex helpers + status snapshot
//   - tokens.js (Phase 4) - JWT mint/verify for the web-companion link
//   - apply.js (Phase 4) - dedupe + apply incoming raid-clear deltas
//
// Re-exports stay explicit so a `require("./local-sync")` import surface
// is greppable from any caller without spelunking through sub-modules.

const state = require("./state");
const tokens = require("./tokens");

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
  TOKEN_DEFAULT_TTL_SEC: tokens.DEFAULT_TTL_SEC,
};
