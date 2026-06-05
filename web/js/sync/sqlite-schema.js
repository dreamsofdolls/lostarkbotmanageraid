import { escapeHtml } from "/sync/js/core/html.js";

export function resolveEncounterSource({ previewCols, encounterCols }) {
  const previewBossCol = pickColumn(previewCols, ["current_boss", "current_boss_name"]);
  const previewTsCol = pickColumn(previewCols, ["fight_start", "last_combat_packet"]);
  if (previewBossCol && previewTsCol) {
    return {
      table: "encounter_preview",
      bossCol: previewBossCol,
      tsCol: previewTsCol,
      charCol: pickColumn(previewCols, ["local_player", "local_player_name"]),
      diffCol: pickColumn(previewCols, ["difficulty"]),
      clearedCol: pickColumn(previewCols, ["cleared"]),
      playersCol: pickColumn(previewCols, ["players"]),
    };
  }

  const encounterBossCol = pickColumn(encounterCols, ["current_boss_name", "current_boss"]);
  const encounterTsCol = pickColumn(encounterCols, ["last_combat_packet", "fight_start"]);
  if (encounterBossCol && encounterTsCol) {
    return {
      table: "encounter",
      bossCol: encounterBossCol,
      tsCol: encounterTsCol,
      charCol: pickColumn(encounterCols, ["local_player", "local_player_name"]),
      diffCol: pickColumn(encounterCols, ["difficulty"]),
      clearedCol: pickColumn(encounterCols, ["cleared"]),
      playersCol: pickColumn(encounterCols, ["players"]),
    };
  }

  return null;
}

export function pickColumn(cols, names) {
  return names.find((name) => cols.has(name)) || null;
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function formatSchemaPreview(tableName, cols) {
  if (!cols || cols.size === 0) return `<code>${escapeHtml(tableName)}</code>: not found`;
  const colPreview = [...cols].slice(0, 16).map(escapeHtml).join(", ");
  return `<code>${escapeHtml(tableName)}</code>: ${colPreview}${cols.size > 16 ? "..." : ""}`;
}

// PRAGMA-based column lister. Returns a Set of column names present on
// `tableName`. Used for schema detection so query SQL adapts to whatever
// LOA Logs version actually wrote the file.
export async function listColumns(sqlite3, db, tableName) {
  const cols = new Set();
  try {
    await sqlite3.exec(db, `PRAGMA table_info(${tableName});`, (row, _columns) => {
      // PRAGMA table_info row layout: [cid, name, type, notnull, dflt_value, pk]
      const name = row[1];
      if (typeof name === "string") cols.add(name);
    });
  } catch (err) {
    console.error("[local-sync] PRAGMA table_info failed:", err);
  }
  return cols;
}
