"use strict";

const { verifyToken, applyLocalSyncDeltas, recordLocalSyncSuccess } = require("./index");
const { getRaidRequirementMap } = require("../../models/Raid");

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
 *   4. Per-char ownership enforced inside applyRaidSetForDiscordId
 *
 * Returns { ok, applied, skipped, unmapped, rejected, lastLocalSyncAt }
 * on success, { ok: false, error } with appropriate HTTP status on failure.
 */
function createRaidSyncEndpoint({ User, applyRaidSetForDiscordId }) {
  if (!User) throw new Error("[sync-endpoint] User model required");
  if (typeof applyRaidSetForDiscordId !== "function") {
    throw new Error("[sync-endpoint] applyRaidSetForDiscordId required");
  }

  // Body size cap: 7 days × ~10 raids × multi-char roster ≈ a few KB at
  // most. 256 KB ceiling protects against accidental + malicious oversend
  // without stress on the JSON parser.
  const MAX_BODY_BYTES = 256 * 1024;

  async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let received = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!raw) return resolve({});
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function extractToken(req, parsedUrl) {
    const auth = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) return match[1].trim();
    // Query fallback so a quick `curl ".../api/raid-sync?token=..."` works
    // for ops smoke testing. Production web companion uses the header.
    return parsedUrl?.query?.token || null;
  }

  function send(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      // CORS: web companion served from the same origin, but be permissive
      // so a future split (e.g. companion on Vercel, API on Railway)
      // doesn't break. Restrict origins later if abuse appears.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(JSON.stringify(body));
  }

  return async function handleRaidSync(req, res, parsedUrl) {
    // Preflight - cheap CORS handshake. Same headers as the actual response.
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    // 1. Token extract + verify.
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

    // 2. Body parse.
    let body;
    try {
      body = await readJsonBody(req);
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
        .select("localSyncEnabled")
        .lean();
    } catch (err) {
      console.error("[sync-endpoint] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }
    if (!userState?.localSyncEnabled) {
      send(res, 409, {
        ok: false,
        error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
      });
      return;
    }

    // 4. Apply.
    let summary;
    try {
      summary = await applyLocalSyncDeltas(discordId, deltas, {
        applyRaidSetForDiscordId,
        getRaidRequirementMap,
      });
    } catch (err) {
      console.error("[sync-endpoint] apply failed:", err?.message || err);
      send(res, 500, { ok: false, error: err.message || "apply failed" });
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

    send(res, 200, {
      ok: true,
      discordId,
      lastLocalSyncAt,
      ...summary,
    });
  };
}

module.exports = { createRaidSyncEndpoint };
