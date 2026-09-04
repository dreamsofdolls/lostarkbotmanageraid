"use strict";

const SOLO_DIFFICULTIES = new Set(["solo", "solo mode"]);

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
    ? `AND LOWER(TRIM(COALESCE(${diffSql}, ''))) IN ('solo', 'solo mode')`
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
    LIMIT 200;
  `;
}
