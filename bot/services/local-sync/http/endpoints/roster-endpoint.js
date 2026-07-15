/**
 * services/local-sync/http/roster-endpoint.js
 * GET /api/me/roster handler · returns a slim roster snapshot for the
 * web companion's diff-view preview. Auth mirrors POST /api/raid-sync
 * (Bearer JWT + stored-token freshness). Projection deliberately
 * excludes sideTasks/sharedTasks/lastRefreshedAt/registeredBy to keep
 * the payload tight and avoid leaking ops metadata.
 */

"use strict";

const { createJsonSender } = require("../json");
const {
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
} = require("../request-gates");

/**
 * Build the `GET /api/me/roster` handler. Returns the user's slim roster
 * snapshot for the web companion's diff-view preview - without it the
 * preview can only show "what will sync" (file-only). With it, the
 * preview can render "currently synced (DB) vs pending sync (file)"
 * per (char, raid, gate, mode) cell.
 *
 * Auth chain mirrors POST /api/raid-sync: Bearer JWT -> verify ->
 * Mongo lookup. No write semantics; pure read.
 *
 * Returns slim JSON - only the fields the web preview needs:
 *   {
 *     ok: true,
 *     discordId,
 *     accounts: [{
 *       accountName,
 *       characters: [{
 *         name, class, itemLevel,
 *         assignedRaids: { armoche: {...}, kazeros: {...}, serca: {...} },
 *       }],
 *     }],
 *   }
 *
 * Other fields on User/account/character (sideTasks, sharedTasks,
 * lastRefreshedAt, registeredBy, etc.) are NOT projected to keep the
 * payload tight + avoid leaking ops metadata to the client.
 */
function createRosterEndpoint({ User }) {
  if (!User) throw new Error("[roster-endpoint] User model required");

  const send = createJsonSender({ methods: "GET, OPTIONS" });

  return async function handleRosterRead(req, res, parsedUrl) {
    if (!guardHttpMethod({ req, res, send, method: "GET" })) return;
    const auth = readVerifiedLocalSyncToken({ req, res, parsedUrl, send });
    if (!auth) return;
    const { token, discordId, payload, scopeExplicit } = auth;
    const scope = payload.scope;

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select("discordId autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.assignedRaids")
        .lean();
    } catch (err) {
      console.error("[roster-endpoint] read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }

    if (!userDoc) {
      // No User doc yet - return empty roster instead of 404 so the web
      // can render gracefully ("no roster registered").
      send(res, 200, { ok: true, discordId, scope, accounts: [] });
      return;
    }
    if (!requireCurrentLocalSyncUser({
      userDoc,
      token,
      payload,
      scopeExplicit,
      res,
      send,
    })) return;

    const accounts = (Array.isArray(userDoc.accounts) ? userDoc.accounts : [])
      .map((account) => ({
        accountName: account.accountName || "",
        characters: (Array.isArray(account.characters) ? account.characters : [])
          .map((c) => ({
            name: c.name || "",
            class: c.class || "",
            itemLevel: Number(c.itemLevel) || 0,
            assignedRaids: c.assignedRaids || {},
          })),
      }));

    send(res, 200, { ok: true, discordId, scope, accounts });
  };
}

module.exports = { createRosterEndpoint };
