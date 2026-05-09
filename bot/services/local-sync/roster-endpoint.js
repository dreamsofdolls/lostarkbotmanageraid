"use strict";

const { verifyToken } = require("./index");

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

  function send(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(JSON.stringify(body));
  }

  function extractToken(req, parsedUrl) {
    const auth = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) return match[1].trim();
    return parsedUrl?.query?.token || null;
  }

  return async function handleRosterRead(req, res, parsedUrl) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const token = extractToken(req, parsedUrl);
    if (!token) {
      send(res, 401, { ok: false, error: "missing token" });
      return;
    }
    const verified = verifyToken(token);
    if (!verified.ok) {
      send(res, 401, { ok: false, error: `token ${verified.reason}` });
      return;
    }
    const discordId = verified.payload.discordId;

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select("discordId accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.assignedRaids")
        .lean();
    } catch (err) {
      console.error("[roster-endpoint] read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }

    if (!userDoc) {
      // No User doc yet - return empty roster instead of 404 so the web
      // can render gracefully ("no roster registered").
      send(res, 200, { ok: true, discordId, accounts: [] });
      return;
    }

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

    send(res, 200, { ok: true, discordId, accounts });
  };
}

module.exports = { createRosterEndpoint };
