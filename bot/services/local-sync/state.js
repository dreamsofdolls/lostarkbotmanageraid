"use strict";

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

  if (enabled) {
    if (force) {
      // Atomic single-update flips both flags + stamps onboarding ts.
      // Used by the stuck-nudge "Switch to local sync" CTA.
      const updated = await UserModel.findOneAndUpdate(
        { discordId },
        {
          $set: {
            localSyncEnabled: true,
            autoManageEnabled: false,
            localSyncLinkedAt: now,
          },
        },
        { upsert: true, setDefaultsOnInsert: true, new: true }
      );
      if (!updated) return { ok: false, reason: RESULT.noUser };
      return { ok: true, reason: RESULT.ok, doc: updated };
    }
    // Strict mode: rejects when autoManageEnabled is true.
    const updated = await UserModel.findOneAndUpdate(
      { discordId, autoManageEnabled: { $ne: true } },
      {
        $set: {
          localSyncEnabled: true,
          localSyncLinkedAt: now,
        },
      },
      { upsert: true, setDefaultsOnInsert: true, new: true }
    );
    if (updated) return { ok: true, reason: RESULT.ok, doc: updated };
    // Filter missed: either user has bible on (conflict) OR upsert-race
    // landed an unexpected doc shape. Probe to disambiguate so the
    // caller can render the right error embed.
    const existing = await UserModel.findOne({ discordId }).lean();
    if (existing?.autoManageEnabled) return { ok: false, reason: RESULT.conflict };
    return { ok: false, reason: RESULT.noUser };
  }

  // enabled === false: simple turn-off. No mutex concern.
  const updated = await UserModel.findOneAndUpdate(
    { discordId },
    {
      $set: {
        localSyncEnabled: false,
        localSyncLinkedAt: null,
      },
    },
    { new: true }
  );
  if (!updated) return { ok: false, reason: RESULT.noUser };
  return { ok: true, reason: RESULT.ok, doc: updated };
}

/**
 * Flip autoManageEnabled with the same mutex semantics in reverse.
 * Used by /raid-auto-manage action:on path + /raid-check Manager
 * "Bật auto-sync hộ" button (Phase 5 wires those over).
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

  if (enabled) {
    const setFields = { autoManageEnabled: true };
    if (stampLastAttempt) setFields.lastAutoManageAttemptAt = Date.now();
    if (force) {
      setFields.localSyncEnabled = false;
      setFields.localSyncLinkedAt = null;
      const updated = await UserModel.findOneAndUpdate(
        { discordId },
        { $set: setFields },
        { upsert: true, setDefaultsOnInsert: true, new: true }
      );
      if (!updated) return { ok: false, reason: RESULT.noUser };
      return { ok: true, reason: RESULT.ok, doc: updated };
    }
    const updated = await UserModel.findOneAndUpdate(
      { discordId, localSyncEnabled: { $ne: true } },
      { $set: setFields },
      { upsert: true, setDefaultsOnInsert: true, new: true }
    );
    if (updated) return { ok: true, reason: RESULT.ok, doc: updated };
    const existing = await UserModel.findOne({ discordId }).lean();
    if (existing?.localSyncEnabled) return { ok: false, reason: RESULT.conflict };
    return { ok: false, reason: RESULT.noUser };
  }

  const updated = await UserModel.findOneAndUpdate(
    { discordId },
    { $set: { autoManageEnabled: false } },
    { new: true }
  );
  if (!updated) return { ok: false, reason: RESULT.noUser };
  return { ok: true, reason: RESULT.ok, doc: updated };
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
 * Stamp lastLocalSyncAt after the web companion successfully POSTs
 * deltas. Conditional filter on localSyncEnabled=true so a stale POST
 * arriving after the user opted out is a no-op (caller surfaces 409).
 */
async function recordLocalSyncSuccess(discordId, deps = {}) {
  const UserModel = requireUserModel("recordLocalSyncSuccess", deps);
  const updated = await UserModel.findOneAndUpdate(
    { discordId, localSyncEnabled: true },
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
