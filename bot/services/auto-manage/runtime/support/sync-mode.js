"use strict";

const { setBibleAutoSyncEnabled, RESULT } = require("../../../local-sync/core/state");

class LocalSyncActiveError extends Error {
  constructor() {
    super("Local Sync is active; Bible sync was cancelled.");
    this.code = "LOCAL_SYNC_ACTIVE";
  }
}

/** Enforce the current sync mode again inside every retryable Bible write. */
function assertBibleSyncAllowed(userDoc) {
  if (userDoc?.localSyncEnabled) throw new LocalSyncActiveError();
}

/** Enable without an initial gather, retaining the atomic Local Sync exclusion. */
async function enableBibleSync(User, discordId) {
  const result = await setBibleAutoSyncEnabled(discordId, true, {}, { UserModel: User });
  if (!result.ok) {
    if (result.reason === RESULT.conflict) throw new LocalSyncActiveError();
    throw new Error("User disappeared while enabling Bible sync.");
  }
  return result.doc;
}

module.exports = { assertBibleSyncAllowed, enableBibleSync };
