// Client-side local-sync preview helpers.
// The bot exports raid/class/difficulty metadata through
// /api/local-sync/catalog; this file consumes that catalog so the web preview
// and server apply path use one source of truth.

"use strict";

export let BOSS_TO_RAID_GATE = new Map();
let RAID_LABELS = {};
export let MODE_LABELS = {};
let RAID_MODE_LABELS = {};

let RAID_GATES = {};
let CLASS_BY_ID = {};
let CLASS_ICON_BY_LABEL = {};
let DIFFICULTY_TO_MODE_KEY = {};
let RAID_MODE_ILVL = {};
let RAID_MODE_BASE = {};
let RAID_MODE_MANUAL_ONLY = {};
let RAID_ORDER = [];
let MODE_ORDER = [];
let catalogLoaded = false;

function normalizeClassLabel(value) {
  return String(value || "").trim().toLowerCase();
}

function buildClassIconByLabel(classesById) {
  const byLabel = {};
  for (const info of Object.values(classesById || {})) {
    const label = normalizeClassLabel(info?.label);
    if (label && info?.icon) {
      byLabel[label] = info.icon;
      byLabel[label.replace(/\s+/g, "")] = info.icon;
    }
  }
  return byLabel;
}

function buildRaidCatalogIndexes(raids) {
  const indexes = {
    raidLabels: {},
    modeLabels: {},
    raidModeLabels: {},
    raidGates: {},
    raidModeIlvl: {},
    raidModeBase: {},
    raidModeManualOnly: {},
  };
  for (const [raidKey, raid] of Object.entries(raids)) {
    indexes.raidLabels[raidKey] = raid?.label || raidKey;
    indexes.raidGates[raidKey] = Array.isArray(raid?.gates) && raid.gates.length > 0
      ? [...raid.gates]
      : ["G1", "G2"];
    indexes.raidModeIlvl[raidKey] = {};
    indexes.raidModeBase[raidKey] = {};
    indexes.raidModeManualOnly[raidKey] = {};
    indexes.raidModeLabels[raidKey] = {};
    for (const [modeKey, mode] of Object.entries(raid?.modes || {})) {
      indexes.modeLabels[modeKey] ||= mode?.label || modeKey;
      indexes.raidModeLabels[raidKey][modeKey] = mode?.label || modeKey;
      indexes.raidModeIlvl[raidKey][modeKey] = Number(mode?.minItemLevel) || 0;
      indexes.raidModeBase[raidKey][modeKey] = mode?.baseModeKey || null;
      indexes.raidModeManualOnly[raidKey][modeKey] = mode?.manualOnly === true;
    }
  }
  return indexes;
}

function configuredOrder(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? [...value] : fallback;
}

export function setCatalog(rawCatalog = {}) {
  const raids = rawCatalog.raids || {};
  const indexes = buildRaidCatalogIndexes(raids);

  BOSS_TO_RAID_GATE = new Map((rawCatalog.bossToRaidGate || []).map(([boss, target]) => [
    boss,
    { raidKey: target?.raidKey, gate: target?.gate },
  ]));
  RAID_LABELS = indexes.raidLabels;
  MODE_LABELS = indexes.modeLabels;
  RAID_MODE_LABELS = indexes.raidModeLabels;
  RAID_GATES = indexes.raidGates;
  RAID_MODE_ILVL = indexes.raidModeIlvl;
  RAID_MODE_BASE = indexes.raidModeBase;
  RAID_MODE_MANUAL_ONLY = indexes.raidModeManualOnly;
  RAID_ORDER = configuredOrder(rawCatalog.raidOrder, Object.keys(raids));
  MODE_ORDER = configuredOrder(rawCatalog.modeOrder, Object.keys(indexes.modeLabels));
  CLASS_BY_ID = rawCatalog.classesById || {};
  CLASS_ICON_BY_LABEL = buildClassIconByLabel(CLASS_BY_ID);
  DIFFICULTY_TO_MODE_KEY = rawCatalog.difficultyToModeKey || {};
  catalogLoaded = true;
  return rawCatalog;
}

export async function loadCatalog(fetcher = globalThis.fetch) {
  if (catalogLoaded) return;
  if (typeof fetcher !== "function") {
    throw new Error("local-sync catalog fetch is unavailable");
  }
  const resp = await fetcher("/api/local-sync/catalog");
  if (!resp?.ok) {
    throw new Error(`local-sync catalog failed: HTTP ${resp?.status || 0}`);
  }
  const data = await resp.json();
  setCatalog(data?.catalog || data);
}

export function getClassIconForLabel(classLabel) {
  return CLASS_ICON_BY_LABEL[normalizeClassLabel(classLabel)] || "";
}

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

function hasCatalogRaidMode(raidKey, modeKey) {
  return Object.prototype.hasOwnProperty.call(
    RAID_MODE_ILVL[raidKey] || {},
    modeKey
  );
}

function normalizeCharName(value) {
  return String(value || "").trim().toLowerCase();
}

export function makeBucketKey(charName, raidKey, modeKey) {
  return `${String(charName || "").trim().toLowerCase()}::${raidKey}::${modeKey}`;
}

export function getClassInfoForChar(playersRaw, charName) {
  const target = normalizeCharName(charName);
  if (!target) return null;
  for (const item of String(playersRaw || "").split(",")) {
    const match = /^(\d+):(.*)$/.exec(item.trim());
    if (!match) continue;
    const [, classId, name] = match;
    if (normalizeCharName(name) !== target) continue;
    const classInfo = CLASS_BY_ID[classId];
    const iconName = classInfo?.icon || "";
    if (!iconName) return { classId, className: classInfo?.label || "" };
    return {
      classId,
      className: classInfo?.label || iconName,
      classIcon: `/sync/class-icons/${iconName}.png`,
    };
  }
  return null;
}

function parseClearedEncounter(row) {
  const [boss, difficulty, cleared, charName, , lastMs, playersRaw] = row;
  if (Number(cleared) !== 1 || !charName) return null;
  const gateInfo = getRaidGateForBoss(boss);
  if (!gateInfo) return null;
  const modeKey = normalizeDifficulty(difficulty);
  if (!modeKey || !hasCatalogRaidMode(gateInfo.raidKey, modeKey)) return null;
  const gates = getGatesForRaid(gateInfo.raidKey);
  const gateIndex = gates.indexOf(gateInfo.gate);
  if (gateIndex < 0) return null;
  return {
    charName,
    classInfo: getClassInfoForChar(playersRaw, charName),
    gateIndex,
    gates,
    lastClearMs: Number(lastMs) || 0,
    modeKey,
    raidKey: gateInfo.raidKey,
  };
}

function createEncounterBucket(encounter) {
  const { charName, classInfo, gateIndex, gates, lastClearMs, modeKey, raidKey } = encounter;
  return {
    charName,
    classId: classInfo?.classId || "",
    className: classInfo?.className || "",
    classIcon: classInfo?.classIcon || "",
    raidKey,
    modeKey,
    gateIndex,
    gates: gates.slice(0, gateIndex + 1),
    raidLabel: RAID_LABELS[raidKey] || raidKey,
    modeLabel: RAID_MODE_LABELS[raidKey]?.[modeKey] || MODE_LABELS[modeKey] || modeKey,
    lastClearMs,
  };
}

function refreshBucketClassInfo(bucket, classInfo) {
  if (bucket.classIcon || !classInfo?.classIcon) return;
  bucket.classId = classInfo.classId || "";
  bucket.className = classInfo.className || "";
  bucket.classIcon = classInfo.classIcon || "";
}

function mergeEncounterBucket(map, encounter) {
  const key = makeBucketKey(encounter.charName, encounter.raidKey, encounter.modeKey);
  const existing = map.get(key);
  if (!existing || encounter.gateIndex > existing.gateIndex) {
    map.set(key, createEncounterBucket(encounter));
    return;
  }
  if (encounter.gateIndex !== existing.gateIndex || encounter.lastClearMs <= existing.lastClearMs) {
    return;
  }
  existing.lastClearMs = encounter.lastClearMs;
  refreshBucketClassInfo(existing, encounter.classInfo);
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
    const encounter = parseClearedEncounter(row);
    if (encounter) mergeEncounterBucket(map, encounter);
  }
  return [...map.values()];
}

/**
 * Surface the bosses present in raw rows that didn't map to any known
 * raid. Distinct from "failed encounters" (cleared=0) - unmapped means
 * the boss exists but the mapping table has no corresponding raid and gate.
 * Returned as a sorted array of unique boss names so the UI can
 * list them for "report this" CTAs.
 */
export function findUnmappedBosses(rows) {
  const set = new Set();
  for (const row of rows) {
    const [boss, , cleared] = row;
    if (Number(cleared) !== 1) continue;
    if (!boss) continue;
    if (!getRaidGateForBoss(boss)) {
      set.add(boss);
    }
  }
  return [...set].sort();
}

// ----- Roster diff (Phase 7: roster-grouped preview) -----

export function currentWeeklyResetStartMs(now = new Date()) {
  const cursor = new Date(now.getTime());
  for (let i = 0; i < 8; i += 1) {
    const day = cursor.getUTCDay();
    if (day === 3 && cursor.getUTCHours() >= 10) {
      return Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        10, 0, 0, 0
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    cursor.setUTCHours(23, 59, 59, 999);
  }
  return now.getTime() - 7 * 24 * 60 * 60 * 1000;
}

function getEligibleRaidModes(itemLevel) {
  const ilvl = Number(itemLevel) || 0;
  const list = [];
  for (const raidKey of RAID_ORDER) {
    for (const modeKey of MODE_ORDER) {
      const min = RAID_MODE_ILVL[raidKey]?.[modeKey];
      if (typeof min !== "number") continue;
      if (RAID_MODE_MANUAL_ONLY[raidKey]?.[modeKey]) continue;
      if (ilvl >= min) list.push({ raidKey, modeKey });
    }
  }
  return list;
}

function indexFileRaidModesByCharacter(fileBuckets) {
  const byCharacter = new Map();
  for (const bucket of fileBuckets || []) {
    const charName = normalizeCharName(bucket?.charName);
    if (!charName) continue;
    if (!byCharacter.has(charName)) byCharacter.set(charName, new Map());
    byCharacter.get(charName).set(
      `${bucket.raidKey}:${bucket.modeKey}`,
      { raidKey: bucket.raidKey, modeKey: bucket.modeKey }
    );
  }
  return byCharacter;
}

function getFileRaidModesForCharacter(fileModesByCharacter, charName, itemLevel) {
  const targetName = normalizeCharName(charName);
  const ilvl = Number(itemLevel) || 0;
  const modes = [];
  for (const entry of fileModesByCharacter.get(targetName)?.values() || []) {
    const minItemLevel = RAID_MODE_ILVL[entry.raidKey]?.[entry.modeKey];
    if (typeof minItemLevel !== "number" || ilvl < minItemLevel) continue;
    modes.push(entry);
  }
  return modes;
}

function dedupeRaidModes(entries) {
  const unique = new Map();
  for (const entry of entries || []) {
    unique.set(`${entry.raidKey}:${entry.modeKey}`, entry);
  }
  return [...unique.values()];
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
 *   "empty"         no actionable state for THIS mode (neither cleared at
 *                   this mode nor pending; OR cleared at a different mode
 *                   with no current-week activity at this mode - the
 *                   off-mode clear is informational but irrelevant for
 *                   the "is this raid+mode worth showing" question and
 *                   was previously a separate "db-other-mode" state -
 *                   collapsed into empty so chars who only do Hard don't
 *                   pollute the Normal raid card)
 */
function resolveCellState({
  assignedRaids,
  fileGates,
  modeKey,
  gate,
  currentWeekStartMs = 0,
}) {
  const dbEntry = assignedRaids?.[gate];
  const completedAt = Number(dbEntry?.completedDate);
  const dbCleared = completedAt > 0 && completedAt >= (Number(currentWeekStartMs) || 0);
  const dbModeKey = normalizeDifficultyLabel(dbEntry?.difficulty);
  const targetModeLabel = normalizeDifficultyLabel(modeKey);
  const fileHas = fileGates && fileGates.has(gate);
  if (dbCleared && (!dbModeKey || dbModeKey === targetModeLabel)) {
    return "synced";
  }
  if (dbCleared && dbModeKey !== targetModeLabel && fileHas) {
    return "mode-conflict";
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
function buildFileClearMap(buckets) {
  const map = new Map();
  for (const b of buckets) {
    const key = makeBucketKey(b.charName, b.raidKey, b.modeKey);
    map.set(key, new Set(b.gates));
  }
  return map;
}

export function buildActionableBucketKeySet(
  diffAccounts,
  { includeModeConflict = true } = {}
) {
  const keys = new Set();
  for (const account of diffAccounts || []) {
    for (const character of account?.characters || []) {
      for (const cell of character?.cells || []) {
        const hasAction = (cell.gates || []).some((gate) => {
          const state = cell.states?.[gate];
          return state === "pending" || (includeModeConflict && state === "mode-conflict");
        });
        if (hasAction) {
          keys.add(makeBucketKey(character.name, cell.raidKey, cell.modeKey));
          if (cell.sourceModeKey && cell.sourceModeKey !== cell.modeKey) {
            keys.add(makeBucketKey(character.name, cell.raidKey, cell.sourceModeKey));
          }
        }
      }
    }
  }
  return keys;
}

export function collectDiffStateCounts(scope) {
  const counts = {};
  const accounts = Array.isArray(scope) ? scope : (scope ? [scope] : []);
  for (const account of accounts) {
    for (const character of account?.characters || []) {
      for (const cell of character?.cells || []) {
        for (const gate of cell.gates || []) {
          const state = cell.states?.[gate];
          if (state) counts[state] = (counts[state] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

function normalizeAllowedModes(allowedModeKeys) {
  if (!Array.isArray(allowedModeKeys)) return null;
  return new Set(allowedModeKeys
    .map((modeKey) => String(modeKey || "").trim().toLowerCase())
    .filter(Boolean));
}

function preferStoredRaidMode(character, entry) {
  const preferredModeKey = character?.assignedRaids?.[entry.raidKey]?.modeKey;
  const preferredBase = RAID_MODE_BASE[entry.raidKey]?.[preferredModeKey];
  return preferredBase === entry.modeKey
    ? { raidKey: entry.raidKey, modeKey: preferredModeKey }
    : entry;
}

function getCharacterRaidModes(character, fileModesByCharacter, allowedModes) {
  const detectedModes = getFileRaidModesForCharacter(
    fileModesByCharacter,
    character?.name,
    character?.itemLevel
  );
  const modes = dedupeRaidModes([
    ...getEligibleRaidModes(character?.itemLevel),
    ...detectedModes,
  ].map((entry) => preferStoredRaidMode(character, entry)));
  return allowedModes
    ? modes.filter((entry) => allowedModes.has(entry.modeKey))
    : modes;
}

function resolveFileGates(fileClearMap, charName, raidKey, modeKey) {
  const directGates = fileClearMap.get(makeBucketKey(charName, raidKey, modeKey));
  const baseModeKey = RAID_MODE_BASE[raidKey]?.[modeKey];
  if (directGates || !baseModeKey) {
    return { sourceModeKey: modeKey, fileGates: directGates };
  }
  return {
    sourceModeKey: baseModeKey,
    fileGates: fileClearMap.get(makeBucketKey(charName, raidKey, baseModeKey)),
  };
}

function buildCharacterCell({
  character,
  charName,
  raidKey,
  modeKey,
  fileClearMap,
  currentWeekStartMs,
}) {
  const gates = getGatesForRaid(raidKey);
  const { sourceModeKey, fileGates } = resolveFileGates(
    fileClearMap,
    charName,
    raidKey,
    modeKey
  );
  const assignedRaids = character?.assignedRaids?.[raidKey];
  const states = Object.fromEntries(gates.map((gate) => [
    gate,
    resolveCellState({
      assignedRaids,
      fileGates,
      modeKey,
      gate,
      currentWeekStartMs,
    }),
  ]));
  if (!Object.values(states).some((state) => state !== "empty")) return null;
  return { raidKey, modeKey, sourceModeKey, gates, states };
}

function appendRaidProjection(charsByRaidMode, character, cell) {
  const key = `${cell.raidKey}_${cell.modeKey}`;
  if (!charsByRaidMode.has(key)) charsByRaidMode.set(key, []);
  charsByRaidMode.get(key).push({
    name: character?.name || "",
    class: character?.class || "",
    itemLevel: Number(character?.itemLevel) || 0,
    gates: cell.gates,
    states: cell.states,
  });
}

function buildCharacterProjection(character, context) {
  const charName = normalizeCharName(character?.name);
  const cells = [];
  const modes = getCharacterRaidModes(
    character,
    context.fileModesByCharacter,
    context.allowedModes
  );
  for (const { raidKey, modeKey } of modes) {
    const cell = buildCharacterCell({
      character,
      charName,
      raidKey,
      modeKey,
      fileClearMap: context.fileClearMap,
      currentWeekStartMs: context.currentWeekStartMs,
    });
    if (!cell) continue;
    cells.push(cell);
    appendRaidProjection(context.charsByRaidMode, character, cell);
  }
  if (cells.length === 0) return null;
  return {
    name: character?.name || "",
    class: character?.class || "",
    itemLevel: Number(character?.itemLevel) || 0,
    cells,
  };
}

function compareCharacters(left, right) {
  return (right.itemLevel - left.itemLevel) || left.name.localeCompare(right.name);
}

function buildRaidCards(charsByRaidMode) {
  const cards = [];
  for (const raidKey of RAID_ORDER) {
    for (const modeKey of MODE_ORDER) {
      const chars = charsByRaidMode.get(`${raidKey}_${modeKey}`);
      if (!chars?.length) continue;
      chars.sort(compareCharacters);
      cards.push({ raidKey, modeKey, chars });
    }
  }
  return cards;
}

function buildAccountDiff(account, sharedContext) {
  const charsByRaidMode = new Map();
  const context = { ...sharedContext, charsByRaidMode };
  const characters = (account?.characters || [])
    .map((character) => buildCharacterProjection(character, context))
    .filter(Boolean)
    .sort(compareCharacters);
  const raidCards = buildRaidCards(charsByRaidMode);
  if (characters.length === 0 && raidCards.length === 0) return null;
  return {
    accountName: account?.accountName || "(unnamed)",
    characters,
    raidCards,
  };
}

/**
 * Build the renderable diff structure with TWO projections of the
 * same per-(char, raid, mode, gate) cell data so the UI can offer
 * toggle between char-first and raid-first views:
 *
 *   - `raidCards`: account -> raid+mode cards -> char rows. Best for
 *     "who in this account cleared raid X". Manager scan flow.
 *   - `characters`: account -> char cards -> raid+mode cells. Best for
 *     "what raids has this char done this week". Default per-user flow.
 *
 * Cells are computed once (resolveCellState) and shared by both views;
 * the projection step just pivots the same data. Cells with all gates
 * empty are filtered out of both views (no point rendering rows of
 * "·" badges because they duplicate the zero-value state).
 *
 * Returns: array of accounts:
 *   [{
 *     accountName,
 *     raidCards: [{ raidKey, modeKey, chars: [{name, class, itemLevel, gates, states}] }],
 *     characters: [{ name, class, itemLevel, cells: [{raidKey, modeKey, gates, states}] }]
 *   }]
 */
export function buildDiff(
  rosterAccounts,
  fileBuckets,
  { allowedModeKeys = null, currentWeekStartMs = 0 } = {}
) {
  const buckets = fileBuckets || [];
  const context = {
    fileClearMap: buildFileClearMap(buckets),
    fileModesByCharacter: indexFileRaidModesByCharacter(buckets),
    allowedModes: normalizeAllowedModes(allowedModeKeys),
    currentWeekStartMs,
  };
  return (rosterAccounts || [])
    .map((account) => buildAccountDiff(account, context))
    .filter(Boolean);
}
