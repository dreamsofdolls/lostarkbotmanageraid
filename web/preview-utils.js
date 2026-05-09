// Client-side mirror of the bot's boss->raid mapping + bucketize logic.
// Web companion uses these to render the "ready to sync" preview in the
// same shape the server's apply.js will actually persist - so the user
// sees exactly what will land in /raid-status, not raw encounters.db rows.
//
// Stays in sync with bot/models/Raid.js BOSS_TO_RAID_GATE +
// bot/services/local-sync/apply.js bucketize. When LOA Logs ships a new
// raid (or a new boss-name variant for an existing raid), update BOTH
// places. The server is authoritative - web previews can be wrong without
// causing data corruption (server re-maps + filters), but visually
// they should match.

"use strict";

// Boss display name (current_boss in encounters.db) -> { raidKey, gate }.
// Mirrors bot/models/Raid.js BOSS_TO_RAID_GATE. Multi-difficulty bosses
// (e.g. Kazeros G2 has two boss names depending on Normal vs Hard/Nightmare)
// list one entry per name; difficulty resolution comes from the
// `difficulty` column.
export const BOSS_TO_RAID_GATE = new Map([
  // Armoche (Act 4)
  ["Brelshaza, Ember in the Ashes", { raidKey: "armoche", gate: "G1" }],
  ["Armoche, Sentinel of the Abyss", { raidKey: "armoche", gate: "G2" }],

  // Kazeros - G2 has two boss names depending on difficulty
  ["Abyss Lord Kazeros", { raidKey: "kazeros", gate: "G1" }],
  ["Archdemon Kazeros", { raidKey: "kazeros", gate: "G2" }],
  ["Death Incarnate Kazeros", { raidKey: "kazeros", gate: "G2" }],

  // Serca
  ["Witch of Agony, Serca", { raidKey: "serca", gate: "G1" }],
  ["Corvus Tul Rak", { raidKey: "serca", gate: "G2" }],
]);

// Raid + mode display labels. Match bot/models/Raid.js RAID_REQUIREMENTS
// label fields so /raid-status raid cards and the web preview read with
// the same vocabulary.
export const RAID_LABELS = {
  armoche: "Act 4",
  kazeros: "Kazeros",
  serca: "Serca",
};

export const MODE_LABELS = {
  normal: "Normal",
  hard: "Hard",
  nightmare: "Nightmare",
};

// Each raid's gate ordering. Used for cumulative-gate expansion (G2
// cleared implies G1 cleared per Lost Ark sequential progression).
const RAID_GATES = {
  armoche: ["G1", "G2"],
  kazeros: ["G1", "G2"],
  serca: ["G1", "G2"],
};

// Difficulty string -> internal modeKey. Permissive on input because
// LOA Logs has shifted strings between versions (Trial -> Inferno ->
// Nightmare). Mirror of bot/services/local-sync/apply.js.
const DIFFICULTY_TO_MODE_KEY = {
  normal: "normal",
  hard: "hard",
  nightmare: "nightmare",
  trial: "nightmare",
  inferno: "nightmare",
};

export function normalizeDifficulty(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return DIFFICULTY_TO_MODE_KEY[text] || null;
}

export function getRaidGateForBoss(bossName) {
  return BOSS_TO_RAID_GATE.get(bossName) || null;
}

export function getGatesForRaid(raidKey) {
  return RAID_GATES[raidKey] || ["G1", "G2"];
}

/**
 * Bucketize raw encounter rows into one entry per (char, raid, mode)
 * tuple, keeping the highest gate cleared. Mirror of
 * bot/services/local-sync/apply.js bucketize so the preview shows the
 * EXACT shape the server will receive (no surprise during sync).
 *
 * Input row shape (from sqlite3.exec callback):
 *   [boss, difficulty, cleared, charName, count, lastMs]
 *
 * Output: array of buckets:
 *   {
 *     charName, raidKey, modeKey, gateIndex,
 *     gates: ["G1", "G2"],          // cumulative expansion
 *     raidLabel: "Kazeros",         // for display
 *     modeLabel: "Normal",          // for display
 *     lastClearMs: 1700000000000,
 *   }
 */
export function bucketize(rows) {
  const map = new Map();
  for (const row of rows) {
    const [boss, difficulty, cleared, charName, _count, lastMs] = row;
    if (Number(cleared) !== 1) continue;
    if (!charName) continue;
    const gateInfo = getRaidGateForBoss(boss);
    if (!gateInfo) continue;
    const modeKey = normalizeDifficulty(difficulty) || "normal";
    const gates = getGatesForRaid(gateInfo.raidKey);
    const gateIndex = gates.indexOf(gateInfo.gate);
    if (gateIndex < 0) continue;
    const bucketKey = `${String(charName).toLowerCase()}::${gateInfo.raidKey}::${modeKey}`;
    const lastClearMs = Number(lastMs) || 0;
    const existing = map.get(bucketKey);
    if (!existing || gateIndex > existing.gateIndex) {
      map.set(bucketKey, {
        charName,
        raidKey: gateInfo.raidKey,
        modeKey,
        gateIndex,
        gates: gates.slice(0, gateIndex + 1),
        raidLabel: RAID_LABELS[gateInfo.raidKey] || gateInfo.raidKey,
        modeLabel: MODE_LABELS[modeKey] || modeKey,
        lastClearMs,
      });
    } else if (gateIndex === existing.gateIndex && lastClearMs > existing.lastClearMs) {
      existing.lastClearMs = lastClearMs;
    }
  }
  return [...map.values()];
}

/**
 * Group buckets by raid+mode key for the per-raid table layout.
 * Returns an array of { groupKey, raidKey, modeKey, raidLabel,
 * modeLabel, buckets[] } sorted by raid order then mode order, with
 * buckets inside each group sorted by lastClearMs descending.
 */
export function groupByRaid(buckets) {
  const groups = new Map();
  for (const b of buckets) {
    const key = `${b.raidKey}_${b.modeKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        raidKey: b.raidKey,
        modeKey: b.modeKey,
        raidLabel: b.raidLabel,
        modeLabel: b.modeLabel,
        buckets: [],
      });
    }
    groups.get(key).buckets.push(b);
  }
  // Stable display order: armoche -> kazeros -> serca, normal ->
  // hard -> nightmare. Same vocabulary as RAID_LABELS so the preview
  // mirrors /raid-status raid card ordering.
  const RAID_ORDER = ["armoche", "kazeros", "serca"];
  const MODE_ORDER = ["normal", "hard", "nightmare"];
  const arr = [...groups.values()];
  arr.sort((a, b) => {
    const r = RAID_ORDER.indexOf(a.raidKey) - RAID_ORDER.indexOf(b.raidKey);
    if (r !== 0) return r;
    return MODE_ORDER.indexOf(a.modeKey) - MODE_ORDER.indexOf(b.modeKey);
  });
  for (const g of arr) {
    g.buckets.sort((a, b) => b.lastClearMs - a.lastClearMs);
  }
  return arr;
}

/**
 * Surface the bosses present in raw rows that didn't map to any known
 * raid. Distinct from "failed encounters" (cleared=0) - unmapped means
 * the boss exists but our table doesn't know which raid+gate it belongs
 * to. Returned as a sorted array of unique boss names so the UI can
 * list them for "report this" CTAs.
 */
export function findUnmappedBosses(rows) {
  const set = new Set();
  for (const row of rows) {
    const [boss, _diff, cleared] = row;
    if (Number(cleared) !== 1) continue;
    if (!boss) continue;
    if (!getRaidGateForBoss(boss)) {
      set.add(boss);
    }
  }
  return [...set].sort();
}
