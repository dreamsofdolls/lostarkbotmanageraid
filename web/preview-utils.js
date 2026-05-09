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

// LOA Logs stores numeric class IDs in encounter_preview.players as
// "classId:name". Map those IDs to the local PNG assets used by the bot's
// Discord emoji bootstrap.
const CLASS_ICON_BY_ID = {
  102: "berserker",
  103: "destroyer",
  104: "warlord",
  105: "holyknight",
  112: "berserker_female",
  113: "holyknight_female",
  202: "arcana",
  203: "summoner",
  204: "bard",
  205: "elemental_master",
  302: "battle_master",
  303: "infighter",
  304: "soulmaster",
  305: "lance_master",
  312: "battle_master_male",
  313: "infighter_male",
  402: "blade",
  403: "demonic",
  404: "reaper",
  405: "soul_eater",
  502: "hawk_eye",
  503: "devil_hunter",
  504: "blaster",
  505: "scouter",
  512: "devil_hunter_female",
  602: "yinyangshi",
  603: "weather_artist",
  604: "alchemist",
  701: "dragon_knight",
  702: "dragon_knight",
};

const CLASS_LABEL_BY_ID = {
  102: "Berserker",
  103: "Destroyer",
  104: "Gunlancer",
  105: "Paladin",
  112: "Slayer",
  113: "Valkyrie",
  202: "Arcanist",
  203: "Summoner",
  204: "Bard",
  205: "Sorceress",
  302: "Wardancer",
  303: "Scrapper",
  304: "Soulfist",
  305: "Glaivier",
  312: "Striker",
  313: "Breaker",
  402: "Deathblade",
  403: "Shadowhunter",
  404: "Reaper",
  405: "Souleater",
  502: "Sharpshooter",
  503: "Deadeye",
  504: "Artillerist",
  505: "Machinist",
  512: "Gunslinger",
  602: "Artist",
  603: "Aeromancer",
  604: "Wildsoul",
  701: "Guardian Knight",
  702: "Guardian Knight",
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

function normalizeCharName(value) {
  return String(value || "").trim().toLowerCase();
}

export function getClassInfoForChar(playersRaw, charName) {
  const target = normalizeCharName(charName);
  if (!target) return null;
  for (const item of String(playersRaw || "").split(",")) {
    const match = /^(\d+):(.*)$/.exec(item.trim());
    if (!match) continue;
    const [, classId, name] = match;
    if (normalizeCharName(name) !== target) continue;
    const iconName = CLASS_ICON_BY_ID[classId];
    if (!iconName) return { classId, className: CLASS_LABEL_BY_ID[classId] || "" };
    return {
      classId,
      className: CLASS_LABEL_BY_ID[classId] || iconName,
      classIcon: `/sync/class-icons/${iconName}.png`,
    };
  }
  return null;
}

/**
 * Bucketize raw encounter rows into one entry per (char, raid, mode)
 * tuple, keeping the highest gate cleared. Mirror of
 * bot/services/local-sync/apply.js bucketize so the preview shows the
 * EXACT shape the server will receive (no surprise during sync).
 *
 * Input row shape (from sqlite3.exec callback):
 *   [boss, difficulty, cleared, charName, count, lastMs, players]
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
    const [boss, difficulty, cleared, charName, _count, lastMs, playersRaw] = row;
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
    const classInfo = getClassInfoForChar(playersRaw, charName);
    const existing = map.get(bucketKey);
    if (!existing || gateIndex > existing.gateIndex) {
      map.set(bucketKey, {
        charName,
        classId: classInfo?.classId || "",
        className: classInfo?.className || "",
        classIcon: classInfo?.classIcon || "",
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
      if (!existing.classIcon && classInfo?.classIcon) {
        existing.classId = classInfo.classId || "";
        existing.className = classInfo.className || "";
        existing.classIcon = classInfo.classIcon || "";
      }
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

// ----- Roster diff (Phase 7: roster-grouped preview) -----

// iLvl gates per (raid, mode). Mirror of bot/models/Raid.js
// RAID_REQUIREMENTS minItemLevel - kept inline so the diff renderer
// can decide which raid/mode cells a char is eligible to show
// without a server round-trip.
const RAID_MODE_ILVL = {
  armoche: { normal: 1700, hard: 1720 },
  kazeros: { normal: 1710, hard: 1730 },
  serca: { normal: 1710, hard: 1730, nightmare: 1740 },
};

// Display order: raid then mode.
const RAID_ORDER = ["armoche", "kazeros", "serca"];
const MODE_ORDER = ["normal", "hard", "nightmare"];

export function getRaidModeIlvl(raidKey, modeKey) {
  return RAID_MODE_ILVL[raidKey]?.[modeKey] ?? 0;
}

export function getEligibleRaidModes(itemLevel) {
  const ilvl = Number(itemLevel) || 0;
  const list = [];
  for (const raidKey of RAID_ORDER) {
    for (const modeKey of MODE_ORDER) {
      const min = RAID_MODE_ILVL[raidKey]?.[modeKey];
      if (typeof min !== "number") continue;
      if (ilvl >= min) list.push({ raidKey, modeKey });
    }
  }
  return list;
}

function normalizeDifficultyLabel(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Resolve cell state for one (char, raid, mode, gate) tuple.
 *
 * Inputs:
 *   - assignedRaids: char's User.assignedRaids[raidKey] sub-doc (may be {})
 *     shape: { G1: { completedDate, difficulty }, G2: {...} }
 *   - fileGates: Set of gates the FILE (encounters.db) has cleared for
 *     this (char, raid, mode) - empty set if no clear
 *   - modeKey: target mode being evaluated
 *   - gate: target gate label ("G1", "G2", ...)
 *
 * State values:
 *   "synced"        DB cleared at this gate AND difficulty matches modeKey
 *   "pending"       file has clear, DB doesn't (or DB has it at THIS mode but
 *                   somehow file says newer - rare; treat as pending so the
 *                   user sees the upcoming write)
 *   "mode-conflict" DB cleared at a different difficulty than modeKey AND
 *                   file has a clear at modeKey - applyRaidSet will wipe
 *                   the old mode and write the new one
 *   "db-other-mode" DB cleared at a different difficulty AND file has no
 *                   clear at modeKey - represents "char was on Normal,
 *                   no Hard activity in last 7 days"
 *   "empty"         neither DB nor file has it
 */
export function resolveCellState({ assignedRaids, fileGates, modeKey, gate }) {
  const dbEntry = assignedRaids?.[gate];
  const dbCleared = dbEntry && Number(dbEntry.completedDate) > 0;
  const dbModeKey = normalizeDifficultyLabel(dbEntry?.difficulty);
  const targetModeLabel = normalizeDifficultyLabel(modeKey);
  const fileHas = fileGates && fileGates.has(gate);
  if (dbCleared && (!dbModeKey || dbModeKey === targetModeLabel)) {
    return "synced";
  }
  if (dbCleared && dbModeKey !== targetModeLabel) {
    return fileHas ? "mode-conflict" : "db-other-mode";
  }
  if (fileHas) return "pending";
  return "empty";
}

/**
 * Build a map keyed by `${charNameLower}::${raidKey}::${modeKey}` -> Set
 * of gates the FILE cleared. Used by resolveCellState. Cumulative gate
 * expansion already applied by bucketize, so a bucket with gates
 * ["G1","G2"] populates both gate entries in the set.
 */
export function buildFileClearMap(buckets) {
  const map = new Map();
  for (const b of buckets) {
    const key = `${String(b.charName).toLowerCase()}::${b.raidKey}::${b.modeKey}`;
    map.set(key, new Set(b.gates));
  }
  return map;
}

/**
 * Build the renderable diff structure: roster -> chars -> raid+mode
 * cells -> gate states. Filters raid+mode combos by char ilvl
 * eligibility so a 1700 char doesn't show Kazeros Hard (1730+ only).
 *
 * Returns: array of accounts:
 *   [{
 *     accountName,
 *     characters: [{
 *       name, class, itemLevel,
 *       cells: [{
 *         raidKey, modeKey,
 *         gates: ["G1", "G2"],
 *         states: { G1: "synced"|"pending"|"mode-conflict"|"db-other-mode"|"empty", G2: ... }
 *       }, ...]
 *     }]
 *   }]
 *
 * Empty rows (no synced + no pending across ALL raid/mode/gate) are
 * filtered out so the user only sees chars with activity. If user
 * wants full eligibility view, that's a separate "show all" toggle
 * we can add later.
 */
export function buildDiff(rosterAccounts, fileBuckets) {
  const fileClearMap = buildFileClearMap(fileBuckets || []);
  const accounts = [];
  for (const account of rosterAccounts || []) {
    const accountName = account?.accountName || "(unnamed)";
    const characters = [];
    for (const character of account?.characters || []) {
      const charNameLower = String(character?.name || "").toLowerCase();
      const eligible = getEligibleRaidModes(character?.itemLevel);
      const cells = [];
      let hasAnyActivity = false;
      for (const { raidKey, modeKey } of eligible) {
        const gates = getGatesForRaid(raidKey);
        const states = {};
        let cellHasActivity = false;
        const fileGates = fileClearMap.get(`${charNameLower}::${raidKey}::${modeKey}`);
        const assignedRaids = character?.assignedRaids?.[raidKey];
        for (const gate of gates) {
          const state = resolveCellState({ assignedRaids, fileGates, modeKey, gate });
          states[gate] = state;
          if (state !== "empty") cellHasActivity = true;
        }
        if (cellHasActivity) hasAnyActivity = true;
        cells.push({ raidKey, modeKey, gates, states });
      }
      if (hasAnyActivity) {
        characters.push({
          name: character?.name || "",
          class: character?.class || "",
          itemLevel: Number(character?.itemLevel) || 0,
          cells,
        });
      }
    }
    if (characters.length > 0) {
      accounts.push({ accountName, characters });
    }
  }
  return accounts;
}
