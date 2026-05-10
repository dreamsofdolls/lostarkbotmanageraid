"use strict";

const { verifyToken, isCurrentStoredToken, bucketizeLocalSyncDeltas } = require("./index");
const { RAID_REQUIREMENTS, getGatesForRaid, getGoldForGate } = require("../../models/Raid");
const { normalizeName } = require("../../utils/raid/common/shared");
const { getStatusRaidsForCharacter } = require("../../utils/raid/common/character");

function makeGateKey(raidKey, modeKey, gate) {
  return `${raidKey}::${modeKey}::${gate}`;
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
  // Counts are RAIDS, not gates - mirrors `summarizeRaidProgress` in
  // bot/utils/raid/common/character.js so the % matches what /raid-status shows.
  // A raid is "completed" iff all its gates have completedDate > 0.
  let totalRaids = 0;
  let clearedRaids = 0;
  let projectedClearedRaids = 0;
  // Per-char rollup for the pending list. Each char carries an array
  // of (raidKey, modeKey, status) so the web can render compact
  // "char: 🟢 Act 4 H · 🟡 Kazeros H · ⚪ Serca NM" rows.
  const charsAfterSync = [];

  for (const account of accounts || []) {
    for (const char of account.characters || []) {
      const charNameLower = normalizeName(char.name);
      const charBuckets = bucketsByCharLower.get(charNameLower) || [];
      const dbClearedGates = new Map();
      const preRaidStates = new Map();

      for (const raid of getStatusRaidsForCharacter(char)) {
        const state = { modeKey: raid.modeKey, cleared: new Set(raid.completedGateKeys || []) };
        for (const gate of state.cleared) {
          dbClearedGates.set(makeGateKey(raid.raidKey, raid.modeKey, gate), true);
        }
        preRaidStates.set(raid.raidKey, state);
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
          accountName: account?.accountName || "",
          charName: char.name || "",
          className: char.class || "",
          itemLevel: Number(char.itemLevel) || 0,
          gold: charGold,
        });
        goldTotal += charGold;
      }

      // Pre-sync clearedRaids comes from preRaidStates. Use both pre +
      // final to keep "currently complete vs post-sync complete" math
      // honest even when post-sync = pre-sync (no applicable deltas).
      for (const [raidKey, state] of preRaidStates.entries()) {
        const gates = getGatesForRaid(raidKey);
        if (state.cleared.size === gates.length) clearedRaids += 1;
      }

      // Walk finalRaidStates to count totalRaids + projectedClearedRaids
      // and build the per-char raid status array. Iterate in canonical
      // RAID_REQUIREMENTS order so the badge sequence is stable across
      // chars (Act 4 → Kazeros → Serca). `incoming` flags raids that
      // will change state as a result of THIS sync (any applied gate in
      // the same raid+mode) so the web UI can highlight them - users
      // need to know which pills are about to flip vs steady-state.
      const charRaidStates = [];
      for (const raidKey of Object.keys(RAID_REQUIREMENTS)) {
        const state = finalRaidStates.get(raidKey);
        if (!state) continue;
        const gates = getGatesForRaid(raidKey);
        totalRaids += 1;
        let status;
        if (state.cleared.size === gates.length) {
          projectedClearedRaids += 1;
          status = "done";
        } else if (state.cleared.size > 0) {
          status = "partial";
        } else {
          status = "pending";
        }
        const incoming = [...appliedGates.values()].some(
          (g) => g.raidKey === raidKey && g.modeKey === state.modeKey
        );
        charRaidStates.push({ raidKey, modeKey: state.modeKey, status, incoming });
      }

      // Include every eligible character so the raid-status preview and
      // gold breakdown stay aligned even when a character becomes fully
      // done after sync. accountName lets the web section by roster.
      if (charRaidStates.length > 0) {
        charsAfterSync.push({
          accountName: account?.accountName || "",
          charName: char.name || "",
          className: char.class || "",
          itemLevel: Number(char.itemLevel) || 0,
          raids: charRaidStates,
        });
      }
    }
  }

  const percent = totalRaids > 0 ? Math.round((clearedRaids / totalRaids) * 100) : 0;
  const projectedPercent = totalRaids > 0
    ? Math.round((projectedClearedRaids / totalRaids) * 100)
    : 0;

  return {
    goldDelta: {
      total: goldTotal,
      byChar: [...goldByChar.values()].sort((a, b) => b.gold - a.gold),
    },
    completion: {
      totalRaids,
      cleared: clearedRaids,
      projected: projectedClearedRaids,
      percent,
      projectedPercent,
    },
    charsAfterSync,
  };
}

/**
 * Build the `POST /api/local-sync/preview-summary` handler. Pre-sync
 * companion stats: gold delta, completion projection, raid status list,
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
        .select("localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt lastLocalSyncAt lastAutoManageSyncAt accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.isGoldEarner accounts.characters.assignedRaids")
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
        completion: { totalRaids: 0, cleared: 0, projected: 0, percent: 0, projectedPercent: 0 },
        charsAfterSync: [],
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
