/**
 * services/local-sync/core/state.js
 * Local-sync mode state machine + mutex helpers. Two sync sources are
 * mutually exclusive (bible vs local) - Mongo conditional updates
 * enforce the mutex at write time so concurrent device flips can't both
 * land. Invariant: every helper here returns
 * `{ ok, reason, doc? }` where reason ∈ "ok" | "conflict" | "no_user"
 * so the callers can render the right error embed without re-querying.
 */

"use strict";

const {
  buildCompanionStateFilter,
  normalizeCompanionScope,
} = require("./scope");

/**
 * State helpers for local-sync mode. The user picks ONE of two sync
 * sources at a time:
 *   - bible auto-sync (autoManageEnabled, existing) - bot pulls clears
 *     from lostark.bible periodically. Requires Public Log on.
 *   - local sync (localSyncEnabled, new in 2026-05-09) - user grants the
 *     web companion FSA access to encounters.db; companion POSTs deltas.
 *
 * Mutex is enforced at the Mongo write layer via conditional
 * findOneAndUpdate so two concurrent flips can't both succeed (e.g.
 * user clicks "Enable bible" on one device + "Enable local" on another
 * within the same tick - exactly one update lands).
 *
 * All helpers take the User model via deps so tests can inject a stub;
 * runtime callers pass require("../../models/user").
 */

const SYNC_MODE = Object.freeze({
  off: "off",
  bible: "bible",
  local: "local",
});

const RESULT = Object.freeze({
  ok: "ok",
  conflict: "conflict",
  noUser: "no_user",
});

function requireUserModel(label, deps) {
  const UserModel = deps?.UserModel;
  if (!UserModel) throw new Error(`${label}: UserModel required in deps`);
  return UserModel;
}

/**
 * Shared conditional-update state transition for the two mutually exclusive
 * sync modes. It owns the repeated enable/force/disable result dispatch while
 * callers provide only the mode-specific fields.
 */
async function updateExclusiveSyncMode({
  UserModel,
  discordId,
  enabled,
  force,
  conflictField,
  enableSet,
  forceSet,
  disableSet,
}) {
  const requiresConflictGuard = Boolean(enabled && !force);
  const filter = requiresConflictGuard
    ? { discordId, [conflictField]: { $ne: true } }
    : { discordId };
  const setFields = enabled
    ? { ...enableSet, ...(force ? forceSet : {}) }
    : disableSet;
  const options = enabled
    ? { upsert: true, setDefaultsOnInsert: true, new: true }
    : { new: true };

  const updated = await UserModel.findOneAndUpdate(
    filter,
    { $set: setFields },
    options
  );
  if (updated) return { ok: true, reason: RESULT.ok, doc: updated };
  if (!requiresConflictGuard) return { ok: false, reason: RESULT.noUser };

  // A guarded write can miss because the opposite mode is active or because
  // no usable document exists. Probe only on that ambiguous path.
  const existing = await UserModel.findOne({ discordId }).lean();
  return existing?.[conflictField]
    ? { ok: false, reason: RESULT.conflict }
    : { ok: false, reason: RESULT.noUser };
}

/**
 * Flip localSyncEnabled. Mutex: rejects when bible auto-sync is on,
 * unless `force: true` (used by the stuck-private-log nudge "Switch to
 * local sync" CTA where the user explicitly opted to swap).
 *
 * Returns { ok, reason, doc? }. Reasons: "ok" | "conflict" | "no_user".
 */
async function setLocalSyncEnabled(discordId, enabled, opts = {}, deps = {}) {
  const UserModel = requireUserModel("setLocalSyncEnabled", deps);
  const { force = false } = opts;
  const now = Date.now();

  return updateExclusiveSyncMode({
    UserModel,
    discordId,
    enabled,
    force,
    conflictField: "autoManageEnabled",
    enableSet: {
      localSyncEnabled: true,
      localSyncLinkedAt: now,
    },
    // Force-mode flips both flags in one atomic write and revokes the old
    // companion token before a newly minted local link can be used.
    forceSet: {
      autoManageEnabled: false,
      lastLocalSyncToken: null,
      lastLocalSyncTokenExpAt: null,
    },
    disableSet: {
      localSyncEnabled: false,
      localSyncLinkedAt: null,
      lastLocalSyncToken: null,
      lastLocalSyncTokenExpAt: null,
    },
  });
}

/**
 * Flip autoManageEnabled with the same mutex semantics in reverse.
 * Used by /raid-auto-manage action:on path + /raid-check Manager
 * "Bật auto-sync hộ" button.
 *
 * `stampLastAttempt: true` adds lastAutoManageAttemptAt to the $set so
 * the existing daily-tick race-guard ("first tick after enable doesn't
 * run a catch-up") stays intact.
 *
 * Returns { ok, reason, doc? }. Reasons: "ok" | "conflict" | "no_user".
 */
async function setBibleAutoSyncEnabled(discordId, enabled, opts = {}, deps = {}) {
  const UserModel = requireUserModel("setBibleAutoSyncEnabled", deps);
  const { force = false, stampLastAttempt = false } = opts;

  return updateExclusiveSyncMode({
    UserModel,
    discordId,
    enabled,
    force,
    conflictField: "localSyncEnabled",
    enableSet: {
      autoManageEnabled: true,
      ...(enabled && stampLastAttempt
        ? { lastAutoManageAttemptAt: Date.now() }
        : {}),
    },
    forceSet: {
      localSyncEnabled: false,
      localSyncLinkedAt: null,
      lastLocalSyncToken: null,
      lastLocalSyncTokenExpAt: null,
    },
    disableSet: {
      autoManageEnabled: false,
      lastLocalSyncToken: null,
      lastLocalSyncTokenExpAt: null,
    },
  });
}

/**
 * Pure helper - resolve a user doc to the active sync mode.
 * Defensive: treats both flags being true as "local wins" (the stricter
 * mutex helpers above prevent that state from being saved, but a
 * legacy doc imported from outside this code path could theoretically
 * have it).
 */
function resolveSyncMode(userDoc) {
  if (!userDoc) return SYNC_MODE.off;
  if (userDoc.localSyncEnabled) return SYNC_MODE.local;
  if (userDoc.autoManageEnabled) return SYNC_MODE.bible;
  return SYNC_MODE.off;
}

/**
 * Read-only status snapshot used by /raid-auto-manage action:status to
 * render both modes' freshness in one embed. Returns a normalized shape
 * regardless of whether the user doc exists (missing doc => all-off).
 */
async function getSyncStatus(discordId, deps = {}) {
  const UserModel = requireUserModel("getSyncStatus", deps);
  const userDoc = await UserModel.findOne({ discordId })
    .select(
      "autoManageEnabled localSyncEnabled lastAutoManageSyncAt lastAutoManageAttemptAt lastLocalSyncAt localSyncLinkedAt"
    )
    .lean();
  if (!userDoc) {
    return {
      mode: SYNC_MODE.off,
      bible: { enabled: false, lastSyncAt: null, lastAttemptAt: null },
      local: { enabled: false, lastSyncAt: null, linkedAt: null },
    };
  }
  return {
    mode: resolveSyncMode(userDoc),
    bible: {
      enabled: !!userDoc.autoManageEnabled,
      lastSyncAt: userDoc.lastAutoManageSyncAt || null,
      lastAttemptAt: userDoc.lastAutoManageAttemptAt || null,
    },
    local: {
      enabled: !!userDoc.localSyncEnabled,
      lastSyncAt: userDoc.lastLocalSyncAt || null,
      linkedAt: userDoc.localSyncLinkedAt || null,
    },
  };
}

/**
 * Stamp lastLocalSyncAt after either web companion successfully POSTs
 * deltas. The conditional filter follows the signed token scope so a
 * stale full link requires local-sync while a Solo companion link
 * requires Bible auto-sync to still be enabled.
 */
async function recordLocalSyncSuccess(discordId, deps = {}) {
  const UserModel = requireUserModel("recordLocalSyncSuccess", deps);
  const scope = normalizeCompanionScope(deps.scope, { legacyDefault: true });
  if (!scope) throw new Error("recordLocalSyncSuccess: invalid companion scope");
  const updated = await UserModel.findOneAndUpdate(
    buildCompanionStateFilter(discordId, scope),
    { $set: { lastLocalSyncAt: Date.now() } },
    { new: true }
  );
  if (!updated) return { ok: false, reason: RESULT.conflict };
  return { ok: true, reason: RESULT.ok };
}

module.exports = {
  SYNC_MODE,
  RESULT,
  setLocalSyncEnabled,
  setBibleAutoSyncEnabled,
  resolveSyncMode,
  getSyncStatus,
  recordLocalSyncSuccess,
};
