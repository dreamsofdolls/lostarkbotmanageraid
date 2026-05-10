"use strict";

const { verifyToken, isCurrentStoredToken, bucketizeLocalSyncDeltas } = require("./index");
const { RAID_REQUIREMENTS, getGatesForRaid, getGoldForGate } = require("../../models/Raid");
const { normalizeName, toModeKey } = require("../../utils/raid/shared");

function makeGateKey(raidKey, modeKey, gate) {
  return `${raidKey}::${modeKey}::${gate}`;
}

function resolveModeKey(raidKey, difficultyLabel) {
  const raw = String(difficultyLabel || "").trim();
  if (!raw) return null;
  const modeKey = toModeKey(raw);
  return RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey] ? modeKey : null;
}

function deriveAssignedRaidMode(raidKey, raidEntry) {
  const counts = new Map();
  for (const gate of getGatesForRaid(raidKey)) {
    const modeKey = resolveModeKey(raidKey, raidEntry?.[gate]?.difficulty);
    if (!modeKey) continue;
    counts.set(modeKey, (counts.get(modeKey) || 0) + 1);
  }

  let bestModeKey = null;
  let bestCount = 0;
  for (const [modeKey, count] of counts.entries()) {
    if (count > bestCount) {
      bestModeKey = modeKey;
      bestCount = count;
    }
  }
  return bestModeKey;
}

function cloneRaidStates(raidStates) {
  const cloned = new Map();
  for (const [raidKey, state] of raidStates.entries()) {
    cloned.set(raidKey, {
      modeKey: state.modeKey,
      cleared: new Set(state.cleared),
    });
  }
  return cloned;
}

/**
 * Walk the user's accounts + characters and compute the four projections.
 * Pure function over (accounts, deltaBuckets) - no DB writes, no async.
 */
function projectSummary(accounts, deltaBuckets) {
  const bucketsByCharLower = new Map();
  for (const bucket of deltaBuckets || []) {
    const key = normalizeName(bucket.charName);
    if (!key) continue;
    if (!bucketsByCharLower.has(key)) bucketsByCharLower.set(key, []);
    bucketsByCharLower.get(key).push(bucket);
  }

  const goldByChar = new Map();
  let goldTotal = 0;
  let totalGates = 0;
  let clearedGates = 0;
  let projectedCleared = 0;
  const pendingPostSync = [];

  for (const account of accounts || []) {
    for (const char of account.characters || []) {
      const charNameLower = normalizeName(char.name);
      const charBuckets = bucketsByCharLower.get(charNameLower) || [];
      const dbClearedGates = new Map();
      const preRaidStates = new Map();

      for (const raidKey of Object.keys(RAID_REQUIREMENTS)) {
        const raidEntry = char.assignedRaids?.[raidKey];
        if (!raidEntry || typeof raidEntry !== "object") continue;
        const modeKey = deriveAssignedRaidMode(raidKey, raidEntry);
        if (!modeKey) continue;

        const state = { modeKey, cleared: new Set() };
        for (const gate of getGatesForRaid(raidKey)) {
          const gateEntry = raidEntry[gate];
          const completedDate = Number(gateEntry?.completedDate) || 0;
          if (completedDate <= 0) continue;

          const gateModeKey = resolveModeKey(raidKey, gateEntry?.difficulty) || modeKey;
          if (gateModeKey !== modeKey) continue;

          clearedGates += 1;
          state.cleared.add(gate);
          dbClearedGates.set(makeGateKey(raidKey, modeKey, gate), true);
        }
        preRaidStates.set(raidKey, state);
      }

      // Simulate the post-sync raid state. Same-mode deltas add gates;
      // cross-mode deltas reset that raid to the incoming mode, matching
      // raid-set mode switching.
      const finalRaidStates = cloneRaidStates(preRaidStates);
      const appliedGates = new Map();
      for (const bucket of charBuckets) {
        if (!RAID_REQUIREMENTS[bucket.raidKey]?.modes?.[bucket.modeKey]) continue;
        const gates = getGatesForRaid(bucket.raidKey);
        let state = finalRaidStates.get(bucket.raidKey);
        if (!state || state.modeKey !== bucket.modeKey) {
          state = { modeKey: bucket.modeKey, cleared: new Set() };
          finalRaidStates.set(bucket.raidKey, state);
        }

        for (let i = 0; i <= bucket.gateIndex && i < gates.length; i += 1) {
          const gate = gates[i];
          const dbKey = makeGateKey(bucket.raidKey, bucket.modeKey, gate);
          if (!dbClearedGates.has(dbKey)) {
            appliedGates.set(dbKey, { raidKey: bucket.raidKey, modeKey: bucket.modeKey, gate });
          }
          state.cleared.add(gate);
        }
      }

      let charGold = 0;
      for (const { raidKey, modeKey, gate } of appliedGates.values()) {
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

      for (const [raidKey, state] of finalRaidStates.entries()) {
        const gates = getGatesForRaid(raidKey);
        totalGates += gates.length;
        projectedCleared += state.cleared.size;

        const stillPending = gates.filter((gate) => !state.cleared.has(gate));
        if (stillPending.length > 0) {
          pendingPostSync.push({
            charName: char.name || "",
            className: char.class || "",
            raidKey,
            modeKey: state.modeKey,
            gates: stillPending,
          });
        }
      }
    }
  }

  const percent = totalGates > 0 ? Math.round((clearedGates / totalGates) * 100) : 0;
  const projectedPercent = totalGates > 0
    ? Math.round((projectedCleared / totalGates) * 100)
    : 0;

  return {
    goldDelta: {
      total: goldTotal,
      byChar: [...goldByChar.values()].sort((a, b) => b.gold - a.gold),
    },
    completion: {
      totalGates,
      cleared: clearedGates,
      projected: projectedCleared,
      percent,
      projectedPercent,
    },
    pendingPostSync,
  };
}

/**
 * Build the `POST /api/local-sync/preview-summary` handler. Pre-sync
 * companion stats: gold delta, completion projection, pending gates list,
 * last-sync timestamps. Lets the user see "if I sync, here's what changes"
 * before clicking the Sync button.
 *
 * Auth chain mirrors the sync endpoint - Bearer JWT, verify, Mongo state
 * check (localSyncEnabled, isCurrentStoredToken). Pure read; no writes.
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

module.exports = { createPreviewSummaryEndpoint, projectSummary };
