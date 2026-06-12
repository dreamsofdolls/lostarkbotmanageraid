/**
 * services/local-sync/http/preview-summary-endpoint.js
 * Pre-sync diff computation for the web companion's "currently synced
 * vs pending" preview. Pure projection over (accounts × deltaBuckets)
 * - no DB writes - so the user can preview the impact before clicking
 * Apply. Mirrors `summarizeRaidProgress` from utils/raid/common so the
 * percent matches what /raid-status shows post-sync.
 */

"use strict";

const { bucketizeLocalSyncDeltas } = require("../..");
const {
  createJsonSender,
  readJsonBody,
} = require("../json");
const {
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
} = require("../request-gates");
const { RAID_REQUIREMENTS, getGatesForRaid, getGoldForGate, isGoldBound } = require("../../../../models/Raid");
const { normalizeName, toModeLabel } = require("../../../../utils/raid/common/shared");
const { getStatusRaidsForCharacter } = require("../../../../utils/raid/common/character");

function makeGateKey(raidKey, modeKey, gate) {
  return `${raidKey}::${modeKey}::${gate}`;
}

function cloneRaidStates(raidStates) {
  const cloned = new Map();
  for (const [raidKey, state] of raidStates.entries()) {
    cloned.set(raidKey, {
      modeKey: state.modeKey,
      cleared: new Map(state.cleared),
    });
  }
  return cloned;
}

function buildSimulatedAssignedRaids(char, finalRaidStates) {
  const assignedRaids = { ...(char?.assignedRaids || {}) };
  for (const [raidKey, state] of finalRaidStates.entries()) {
    const source = char?.assignedRaids?.[raidKey] || {};
    const modeLabel = toModeLabel(state.modeKey);
    const raidData = { modeKey: state.modeKey };
    if (source.goldOverride === "include" || source.goldForced === true) {
      raidData.goldOverride = "include";
    } else if (source.goldOverride === "exclude" || source.goldDisabled === true) {
      raidData.goldOverride = "exclude";
    }
    for (const gate of getGatesForRaid(raidKey)) {
      raidData[gate] = {
        difficulty: modeLabel,
        completedDate: state.cleared.get(gate) || null,
      };
    }
    assignedRaids[raidKey] = raidData;
  }
  return assignedRaids;
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
  let goldBoundTotal = 0;
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
        const state = { modeKey: raid.modeKey, cleared: new Map() };
        for (const gate of raid.completedGateKeys || []) {
          state.cleared.set(
            gate,
            Number(char?.assignedRaids?.[raid.raidKey]?.[gate]?.completedDate) ||
              Number(raid.completedAt) ||
              0
          );
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
          state = { modeKey: bucket.modeKey, cleared: new Map() };
          finalRaidStates.set(bucket.raidKey, state);
        }

        for (let i = 0; i <= bucket.gateIndex && i < gates.length; i += 1) {
          const gate = gates[i];
          const dbKey = makeGateKey(bucket.raidKey, bucket.modeKey, gate);
          if (!dbClearedGates.has(dbKey)) {
            appliedGates.set(dbKey, { raidKey: bucket.raidKey, modeKey: bucket.modeKey, gate });
          }
          state.cleared.set(gate, Number(bucket.lastClearMs) || Date.now());
        }
      }

      const simulatedChar = {
        ...char,
        assignedRaids: buildSimulatedAssignedRaids(char, finalRaidStates),
      };
      const finalRaidEntriesByKey = new Map(
        getStatusRaidsForCharacter(simulatedChar).map((raid) => [raid.raidKey, raid])
      );
      let charGold = 0;
      let charGoldBound = 0;
      for (const { raidKey, modeKey, gate } of appliedGates.values()) {
        const finalRaid = finalRaidEntriesByKey.get(raidKey);
        if (char.isGoldEarner !== false && finalRaid?.goldReceives) {
          const g = getGoldForGate(raidKey, modeKey, gate);
          charGold += g;
          if (isGoldBound(raidKey, modeKey)) charGoldBound += g;
        }
      }
      if (charGold > 0) {
        goldByChar.set(char.name, {
          accountName: account?.accountName || "",
          charName: char.name || "",
          className: char.class || "",
          itemLevel: Number(char.itemLevel) || 0,
          gold: charGold,
          goldBound: charGoldBound,
        });
        goldTotal += charGold;
        goldBoundTotal += charGoldBound;
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
      // chars (Act 4 → Kazeros → Serca → Horizon). `incoming` flags raids that
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
      boundTotal: goldBoundTotal,
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
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handlePreviewSummary(req, res, parsedUrl) {
    if (!guardHttpMethod({ req, res, send, method: "POST" })) return;
    const auth = readVerifiedLocalSyncToken({ req, res, parsedUrl, send });
    if (!auth) return;
    const { token, discordId } = auth;

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
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
        goldDelta: { total: 0, boundTotal: 0, byChar: [] },
        completion: { totalRaids: 0, cleared: 0, projected: 0, percent: 0, projectedPercent: 0 },
        charsAfterSync: [],
        lastSync: { localSyncAt: null, autoManageSyncAt: null },
      });
      return;
    }
    if (!requireCurrentLocalSyncUser({ userDoc, token, res, send })) return;

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
