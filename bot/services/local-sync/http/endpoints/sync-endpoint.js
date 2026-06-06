/**
 * services/local-sync/http/sync-endpoint.js
 * POST /api/raid-sync handler. Auth chain: Bearer JWT → signature
 * verify → Mongo localSyncEnabled check → stored-token freshness check
 * → apply. On any applied row, the stored token's effective expiry is
 * shrunk to now+60s so a leaked URL post-sync is only useful for ~1
 * minute (defense in depth · the JWT itself still has its full TTL).
 */

"use strict";

const {
  TOKEN_POST_SYNC_TTL_SEC,
  applyLocalSyncDeltas,
  recordLocalSyncSuccess,
} = require("../..");
const {
  createJsonSender,
  readJsonBody,
} = require("../json");
const {
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
} = require("../request-gates");
const { getRaidRequirementMap } = require("../../../../models/Raid");

/**
 * Build the POST /api/raid-sync handler. Factory pattern so bot.js can
 * inject the User model + applyRaidSetForDiscordId without circular
 * imports - this module sits below `bot/handlers` in the dependency
 * graph, so we can't import the handler directly here.
 *
 * Auth chain:
 *   1. Authorization: Bearer <jwt> header (or `?token=` query fallback)
 *   2. Token verify (signature + expiry)
 *   3. Mongo state check: localSyncEnabled === true (rejects if user
 *      opted out between mint and POST - "stale POST" guard)
 *   4. Per-char ownership enforced inside the raid-set write path
 *
 * Returns { ok, applied, skipped, unmapped, rejected, lastLocalSyncAt }
 * on success, { ok: false, error } with appropriate HTTP status on failure.
 */
function createRaidSyncEndpoint({ User, applyRaidSetForDiscordId, applyRaidSetBatchForDiscordId = null }) {
  if (!User) throw new Error("[sync-endpoint] User model required");
  if (typeof applyRaidSetForDiscordId !== "function") {
    throw new Error("[sync-endpoint] applyRaidSetForDiscordId required");
  }

  // Body size cap: one raid week × ~10 raids × multi-char roster ≈ a few KB at
  // most. 256 KB ceiling protects against accidental + malicious oversend
  // without stress on the JSON parser.
  const MAX_BODY_BYTES = 256 * 1024;
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handleRaidSync(req, res, parsedUrl) {
    if (!guardHttpMethod({ req, res, send, method: "POST" })) return;
    const auth = readVerifiedLocalSyncToken({ req, res, parsedUrl, send });
    if (!auth) return;
    const { token, discordId } = auth;

    // 2. Body parse.
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      send(res, err.status || 400, { ok: false, error: err.message || "bad body" });
      return;
    }
    const deltas = Array.isArray(body?.deltas) ? body.deltas : null;
    if (!deltas) {
      send(res, 400, { ok: false, error: "deltas array required" });
      return;
    }

    // 3. State check: localSyncEnabled. Stale POST guard - if user ran
    // /raid-auto-manage action:local-off after the mint but before this
    // POST, reject with 409 instead of silently writing data the user
    // explicitly turned off. recordLocalSyncSuccess later filters on the
    // same flag (defense in depth).
    let userState;
    try {
      userState = await User.findOne({ discordId })
        .select("localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt accounts")
        .lean();
    } catch (err) {
      console.error("[sync-endpoint] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }
    if (!requireCurrentLocalSyncUser({ userDoc: userState, token, res, send })) return;

    // 4. Apply.
    let summary;
    try {
      summary = await applyLocalSyncDeltas(discordId, deltas, {
        applyRaidSetForDiscordId,
        applyRaidSetBatchForDiscordId,
        getRaidRequirementMap,
        userDoc: userState,
        requireLocalSyncEnabled: true,
      });
    } catch (err) {
      console.error("[sync-endpoint] apply failed:", err?.message || err);
      send(res, 500, { ok: false, error: err.message || "apply failed" });
      return;
    }
    if ((summary?.rejected || []).some((item) => item.reason === "local_sync_disabled")) {
      send(res, 409, {
        ok: false,
        error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
        ...summary,
      });
      return;
    }

    // 5. Stamp lastLocalSyncAt. Best-effort - if it fails, the data is
    // already written so we don't roll back; just log + still return ok.
    let lastLocalSyncAt = null;
    try {
      const stampResult = await recordLocalSyncSuccess(discordId, { UserModel: User });
      if (stampResult.ok) lastLocalSyncAt = Date.now();
    } catch (err) {
      console.warn("[sync-endpoint] timestamp stamp failed:", err?.message || err);
    }

    // 6. On successful apply (anything written), shrink the stored token's
    // effective expiry to now+60s. The JWT itself stays valid for the rest
    // of its natural TTL but isCurrentStoredToken() will reject it after
    // 60s, so a leaked URL post-sync is only useful for ~1 minute.
    // "Successful" = at least one applied row; nothing-to-sync (all skipped
    // or all rejected) does NOT shrink because the user may still want
    // those minutes to retry with a different file.
    let newExpSec = null;
    const appliedCount = Array.isArray(summary?.applied) ? summary.applied.length : 0;
    if (appliedCount > 0) {
      const shrunkAt = Math.floor(Date.now() / 1000) + TOKEN_POST_SYNC_TTL_SEC;
      try {
        await User.updateOne(
          { discordId, lastLocalSyncToken: token },
          { $set: { lastLocalSyncTokenExpAt: shrunkAt } }
        );
        newExpSec = shrunkAt;
      } catch (err) {
        console.warn("[sync-endpoint] token shrink failed:", err?.message || err);
      }
    }

    send(res, 200, {
      ok: true,
      discordId,
      lastLocalSyncAt,
      newExpSec,
      ...summary,
    });
  };
}

module.exports = { createRaidSyncEndpoint };
