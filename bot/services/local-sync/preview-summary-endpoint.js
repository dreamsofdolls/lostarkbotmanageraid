"use strict";

const { verifyToken, isCurrentStoredToken, bucketizeLocalSyncDeltas } = require("./index");
const { RAID_REQUIREMENTS, getGatesForRaid, getGoldForGate } = require("../../models/Raid");
const { normalizeName, toModeLabel } = require("../../utils/raid/shared");

/**
 * Build the `POST /api/local-sync/preview-summary` handler. Pre-sync
 * companion stats: gold delta, completion projection, pending gates list,
 * last-sync timestamps. Lets the user see "if I sync, here's what changes"
 * BEFORE clicking the Sync button.
 *
 * Auth chain mirrors the sync endpoint - Bearer JWT, verify, Mongo state
 * check (localSyncEnabled, isCurrentStoredToken). Pure read; no writes.
 *
 * Server-side computation reuses bot's gold table + bucketize logic so
 * the web client never sees raw gold rates - single source of truth.
 *
 * Response shape:
 *   {
 *     ok, goldDelta: { total, byChar: [{charName, className, gold}] },
 *     completion: { totalGates, cleared, projected, percent, projectedPercent },
 *     pendingPostSync: [{ charName, raidKey, modeKey, gates: ["G1","G2"] }],
 *     lastSync: { localSyncAt, autoManageSyncAt }
 *   }
 */
function createPreviewSummaryEndpoint({ User }) {
  if (!User) throw new Error("[preview-summary] User model required");

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
    return parsedUrl?.query?.token || null;
  }

  function send(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(JSON.stringify(body));
  }

  /**
   * Walk the user's accounts + characters and compute the four projections.
   * Pure function over (accounts, deltaBuckets) - no DB writes, no async.
   */
  function projectSummary(accounts, deltaBuckets) {
    // Index buckets by normalized char name for O(1) char lookup.
    const bucketsByCharLower = new Map();
    for (const b of deltaBuckets) {
      const key = normalizeName(b.charName);
      if (!bucketsByCharLower.has(key)) bucketsByCharLower.set(key, []);
      bucketsByCharLower.get(key).push(b);
    }

    const goldByChar = new Map();
    let goldTotal = 0;
    let totalGates = 0;
    let clearedGates = 0;
    let projectedGates = 0;
    const pendingPostSync = [];

    for (const account of accounts || []) {
      for (const char of account.characters || []) {
        const charNameLower = normalizeName(char.name);
        const charBuckets = bucketsByCharLower.get(charNameLower) || [];
        // Per-char projection state - tracks which (raid, mode, gate) are
        // currently DB-cleared and which the bucket would mark cleared.
        // Gate set is small (≤2 per raid × 3 raids) so plain Set is fine.
        const dbClearedGates = new Map(); // `${raid}::${mode}::${gate}` -> true
        const currentModes = {}; // raidKey -> modeKey for "configured" raids
        for (const raidKey of Object.keys(RAID_REQUIREMENTS)) {
          const raidEntry = char.assignedRaids?.[raidKey];
          if (!raidEntry || typeof raidEntry !== "object") continue;
          const difficultyLabel = raidEntry.difficulty;
          // `difficulty` is stored as the human label ("Hard"); convert
          // to lowercase modeKey for our gold/gates lookup.
          const modeKey = (typeof difficultyLabel === "string" ? difficultyLabel : "")
            .toLowerCase();
          if (!RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey]) continue;
          currentModes[raidKey] = modeKey;
          for (const gate of getGatesForRaid(raidKey)) {
            totalGates += 1;
            const gateEntry = raidEntry[gate];
            const completedDate = Number(gateEntry?.completedDate) || 0;
            if (completedDate > 0) {
              clearedGates += 1;
              dbClearedGates.set(`${raidKey}::${modeKey}::${gate}`, true);
            }
          }
        }

        // Apply each bucket: cumulative gates G1..G_(gateIndex) get
        // marked. Skip those already cleared in DB (no double-count).
        // Gold is summed per applied gate × isGoldEarner.
        let charGold = 0;
        const appliedGates = new Map(); // `${raid}::${mode}::${gate}` -> {raid,mode,gate}
        for (const bucket of charBuckets) {
          const gates = getGatesForRaid(bucket.raidKey);
          for (let i = 0; i <= bucket.gateIndex && i < gates.length; i += 1) {
            const gate = gates[i];
            const dbKey = `${bucket.raidKey}::${bucket.modeKey}::${gate}`;
            if (dbClearedGates.has(dbKey)) continue; // already cleared
            appliedGates.set(dbKey, { raidKey: bucket.raidKey, modeKey: bucket.modeKey, gate });
          }
        }
        for (const { raidKey, modeKey, gate } of appliedGates.values()) {
          // Only count toward projected if the (raid, mode) is the char's
          // current configured mode - delta in another mode would wipe
          // and rewrite, so the projection is "post-sync state" which
          // matches whatever the delta declares. For completion %, count
          // the new cleared regardless (gates have replaced the prior).
          projectedGates += 1;
          if (char.isGoldEarner !== false) {
            charGold += getGoldForGate(raidKey, modeKey, gate);
          }
        }
        if (charGold > 0) {
          goldByChar.set(char.name, {
            charName: char.name || "",
            className: char.class || "",
            gold: charGold,
          });
          goldTotal += charGold;
        }

        // Pending post-sync: gates configured for this char that are
        // neither in DB nor in delta. Collapsed per (raid, mode).
        for (const [raidKey, modeKey] of Object.entries(currentModes)) {
          const stillPending = [];
          for (const gate of getGatesForRaid(raidKey)) {
            const dbKey = `${raidKey}::${modeKey}::${gate}`;
            if (dbClearedGates.has(dbKey)) continue;
            // appliedGates also covers cross-mode applied; only count
            // pending in the char's CURRENT configured mode.
            const sameModeAppliedKey = `${raidKey}::${modeKey}::${gate}`;
            if (appliedGates.has(sameModeAppliedKey)) continue;
            stillPending.push(gate);
          }
          if (stillPending.length > 0) {
            pendingPostSync.push({
              charName: char.name || "",
              className: char.class || "",
              raidKey,
              modeKey,
              gates: stillPending,
            });
          }
        }
      }
    }

    // Add applied gates that are in the char's current configured mode
    // back into the "projected cleared" tally - they replace prior state.
    // Cleared count uses pre-sync DB state; projected is cleared + delta.
    const projectedCleared = clearedGates + (projectedGates - 0);
    // Cap projected at totalGates so re-syncs that overlap configured
    // raids don't push the % above 100.
    const projectedClearedCapped = Math.min(projectedCleared, totalGates);
    const percent = totalGates > 0 ? Math.round((clearedGates / totalGates) * 100) : 0;
    const projectedPercent = totalGates > 0
      ? Math.round((projectedClearedCapped / totalGates) * 100)
      : 0;

    return {
      goldDelta: {
        total: goldTotal,
        byChar: [...goldByChar.values()].sort((a, b) => b.gold - a.gold),
      },
      completion: {
        totalGates,
        cleared: clearedGates,
        projected: projectedClearedCapped,
        percent,
        projectedPercent,
      },
      pendingPostSync,
    };
  }

  return async function handlePreviewSummary(req, res, parsedUrl) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "POST") {
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

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      send(res, err.status || 400, { ok: false, error: err.message || "bad body" });
      return;
    }
    const deltas = Array.isArray(body?.deltas) ? body.deltas : [];

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select("localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt lastLocalSyncAt lastAutoManageSyncAt accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.isGoldEarner accounts.characters.assignedRaids")
        .lean();
    } catch (err) {
      console.error("[preview-summary] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }

    if (!userDoc) {
      send(res, 200, {
        ok: true,
        goldDelta: { total: 0, byChar: [] },
        completion: { totalGates: 0, cleared: 0, projected: 0, percent: 0, projectedPercent: 0 },
        pendingPostSync: [],
        lastSync: { localSyncAt: null, autoManageSyncAt: null },
      });
      return;
    }
    if (!userDoc.localSyncEnabled) {
      send(res, 409, {
        ok: false,
        error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
      });
      return;
    }
    if (!isCurrentStoredToken(userDoc, token)) {
      send(res, 401, {
        ok: false,
        error: "token revoked - open a new local-sync link",
      });
      return;
    }

    const buckets = bucketizeLocalSyncDeltas(deltas);
    const summary = projectSummary(userDoc.accounts || [], buckets);

    send(res, 200, {
      ok: true,
      ...summary,
      lastSync: {
        localSyncAt: Number(userDoc.lastLocalSyncAt) || null,
        autoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || null,
      },
    });
  };
}

module.exports = { createPreviewSummaryEndpoint };
