"use strict";

const SOLO_DIFFICULTIES = new Set(["solo", "solo mode"]);
// Each group becomes at most one delta, and capPartyDeltas trims party deltas
// to the same count. Matches MAX_PREVIEW_DELTAS in
// bot/services/local-sync/core/preview-jobs.js; tests keep them equal.
const MAX_ENCOUNTER_GROUPS = 512;

/**
 * Keep as many party deltas as a preview job accepts, newest clears first.
 * The server refuses the whole job, the user's own clears included, when
 * partyDeltas pass its delta limit, which a large party history can reach.
 * @param {Array<{lastClearMs: number}>} partyDeltas - party clears to send
 * @returns {Array<{lastClearMs: number}>} the same list when within the limit
 */
export function capPartyDeltas(partyDeltas) {
  if (partyDeltas.length <= MAX_ENCOUNTER_GROUPS) return partyDeltas;
  return [...partyDeltas]
    .sort((a, b) => b.lastClearMs - a.lastClearMs)
    .slice(0, MAX_ENCOUNTER_GROUPS);
}

function isSoloDifficulty(value) {
  return SOLO_DIFFICULTIES.has(String(value || "").trim().toLowerCase());
}

export function filterRowsForSyncScope(rows, scope) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (scope !== "solo") return safeRows;
  return safeRows.filter((row) => isSoloDifficulty(row?.[1]));
}

export function buildEncounterPreviewSql({
  tableSql,
  bossSql,
  tsSql,
  diffSql = null,
  clearedSql = null,
  charSql = null,
  playersSql = null,
  scope = "full",
}) {
  if (scope === "solo" && !diffSql) {
    throw new Error("Solo sync requires an encounter difficulty column.");
  }

  const difficultySelect = diffSql ? `COALESCE(${diffSql}, '')` : `'Normal'`;
  // SQLite associates bare result columns with the row selected by the sole
  // MAX() aggregate. This keeps `players` and `last_ms` from the same latest
  // encounter instead of choosing the lexicographically largest party text.
  const playersSelect = playersSql ? `COALESCE(${playersSql}, '')` : `''`;
  const soloWhere = scope === "solo"
    ? `AND LOWER(TRIM(COALESCE(${diffSql}, ''))) IN (${[...SOLO_DIFFICULTIES].map((q) => `'${q}'`).join(", ")})`
    : "";

  return `
    SELECT ${bossSql} AS boss,
           ${difficultySelect} AS difficulty,
           ${clearedSql || `1`} AS cleared,
           ${charSql ? `COALESCE(${charSql}, '')` : `''`} AS char_name,
           COUNT(*) AS n,
           MAX(${tsSql}) AS last_ms,
           ${playersSelect} AS players
    FROM ${tableSql}
    WHERE ${tsSql} >= ?
      AND ${bossSql} IS NOT NULL
      AND ${bossSql} != ''
      ${clearedSql ? `AND ${clearedSql} = 1` : ""}
      ${soloWhere}
    GROUP BY boss, difficulty, cleared, char_name
    ORDER BY last_ms DESC
    LIMIT ${MAX_ENCOUNTER_GROUPS};
  `;
}
