"use strict";

import {
  loadCatalog,
  BOSS_TO_RAID_GATE,
} from "/sync/js/sync/preview-utils.js";
import { createStableFileSnapshot } from "/sync/js/sync/file-snapshot.js";
import { t } from "/sync/js/core/i18n.js";
import { SUPPORT_DPS_PROFILE_SPEC_KEYS } from "/sync/js/profile/profile-role.js";
import {
  buildProfileEncounterSummaries,
  buildProfileSnapshot,
  fingerprintSnapshot,
} from "/sync/js/profile/profile-snapshot.js";
import {
  enrichProfileRows,
  isModernProfileRow,
} from "/sync/js/profile/profile-row-enrich.js";

const WA_SQLITE_VERSION = "1.3.0";
const WA_SQLITE_BASE = `https://cdn.jsdelivr.net/npm/@journeyapps/wa-sqlite@${WA_SQLITE_VERSION}`;
const PROFILE_SESSION_STORAGE_KEY = "artist-profile-sync-session";
const PROFILE_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_DURATION_MS = 180000;

let profileSyncTimer = null;
let profileSyncInFlight = false;
let lastProfileFingerprint = "";
let stableProfileSourceFile = null;
let stableProfileSnapshotFile = null;

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function sqlString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function sqlStringList(values) {
  return (values || []).map(sqlString).join(", ");
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function withSqliteDb(file, fn) {
  const [SQLiteESMFactoryModule, SQLiteAPI, FileVfsModule] = await Promise.all([
    import(`${WA_SQLITE_BASE}/dist/wa-sqlite-async.mjs`),
    import(`${WA_SQLITE_BASE}/src/sqlite-api.js`),
    import("/sync/js/sync/file-vfs.js"),
  ]);
  const SQLiteESMFactory = SQLiteESMFactoryModule.default;
  const { FileBackedVFS } = FileVfsModule;
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLiteAPI.Factory(module);
  const vfsName = `profile-vfs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const vfs = await FileBackedVFS.create(vfsName, module, { "encounters.db": file });
  sqlite3.vfs_register(vfs, false);
  const db = await sqlite3.open_v2(
    "encounters.db",
    SQLiteAPI.SQLITE_OPEN_READONLY,
    vfsName
  );
  try {
    return await fn(sqlite3, db);
  } finally {
    await sqlite3.close(db);
  }
}

async function listColumns(sqlite3, db, tableName) {
  const cols = new Set();
  try {
    await sqlite3.exec(db, `PRAGMA table_info(${quoteIdent(tableName)});`, (row) => {
      const name = row[1];
      if (typeof name === "string") cols.add(name);
    });
  } catch {
    // Caller treats missing required columns as "profile sync unavailable".
  }
  return cols;
}

function pickColumn(cols, names) {
  return names.find((name) => cols.has(name)) || null;
}

function buildRosterLookup(accounts) {
  const byName = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    for (const character of account.characters || []) {
      const key = normalizeName(character.name);
      if (!key || byName.has(key)) continue;
      byName.set(key, {
        accountName: account.accountName || "",
        name: character.name || "",
        class: character.class || "",
        itemLevel: Number(character.itemLevel) || 0,
      });
    }
  }
  return byName;
}

async function queryProfileRows(file, rosterAccounts, { minFightStartMs = 0 } = {}) {
  await loadCatalog();
  const rosterByName = buildRosterLookup(rosterAccounts);
  if (rosterByName.size === 0 || BOSS_TO_RAID_GATE.size === 0) return [];

  return withSqliteDb(file, async (sqlite3, db) => {
    const previewCols = await listColumns(sqlite3, db, "encounter_preview");
    const entityCols = await listColumns(sqlite3, db, "entity");
    const encounterCols = await listColumns(sqlite3, db, "encounter");
    const bossCol = pickColumn(previewCols, ["current_boss", "current_boss_name"]);
    const tsCol = pickColumn(previewCols, ["fight_start", "last_combat_packet"]);
    const diffCol = pickColumn(previewCols, ["difficulty"]);
    const clearedCol = pickColumn(previewCols, ["cleared"]);
    const charCol = pickColumn(previewCols, ["local_player", "local_player_name"]);
    const durationCol = pickColumn(previewCols, ["duration"]);
    const playersCol = pickColumn(previewCols, ["players"]);
    if (!bossCol || !tsCol || !charCol || !durationCol || !clearedCol) {
      throw new Error("profile sync requires encounter_preview boss/time/local_player/duration/cleared columns");
    }
    if (!entityCols.has("encounter_id") || !entityCols.has("name") || !entityCols.has("dps") || !entityCols.has("entity_type")) {
      throw new Error("profile sync requires entity encounter_id/name/entity_type/dps columns");
    }

    const pCol = (name) => `ep.${quoteIdent(name)}`;
    const bossSql = pCol(bossCol);
    const tsSql = pCol(tsCol);
    const diffSql = diffCol ? pCol(diffCol) : "'Normal'";
    const charSql = pCol(charCol);
    const clearedSql = pCol(clearedCol);
    const durationSql = pCol(durationCol);
    const playersSql = playersCol ? pCol(playersCol) : "''";
    const supportedBosses = [...BOSS_TO_RAID_GATE.keys()].map(sqlString).join(", ");
    const minFightStart = Number(minFightStartMs) || 0;
    const minFightStartFilter = minFightStart > 0 ? `AND ${tsSql} >= ${Math.floor(minFightStart)}` : "";
    const durationMsExpr = `CASE WHEN ${durationSql} > 0 AND ${durationSql} < 10000 THEN ${durationSql} * 1000 ELSE ${durationSql} END`;
    const hasEncounterTable = encounterCols.has("id");
    const encounterJoin = hasEncounterTable ? "LEFT JOIN encounter enc ON enc.id = ep.id" : "";
    const encounterMiscExpr = hasEncounterTable && encounterCols.has("misc") ? `enc.${quoteIdent("misc")}` : "NULL";
    const encounterBuffsExpr = hasEncounterTable && encounterCols.has("buffs") ? `enc.${quoteIdent("buffs")}` : "NULL";
    const encounterDebuffsExpr = hasEncounterTable && encounterCols.has("debuffs") ? `enc.${quoteIdent("debuffs")}` : "NULL";
    const encounterShieldBuffsExpr = hasEncounterTable && encounterCols.has("applied_shield_buffs") ? `enc.${quoteIdent("applied_shield_buffs")}` : "NULL";
    const encounterTotalDamageExpr = hasEncounterTable && encounterCols.has("total_damage_dealt") ? `COALESCE(enc.${quoteIdent("total_damage_dealt")}, 0)` : "0";
    const encounterTopDamageExpr = hasEncounterTable && encounterCols.has("top_damage_dealt") ? `COALESCE(enc.${quoteIdent("top_damage_dealt")}, 0)` : "0";
    const encounterTotalDamageTakenExpr = hasEncounterTable && encounterCols.has("total_damage_taken") ? `COALESCE(enc.${quoteIdent("total_damage_taken")}, 0)` : "0";

    const eCol = (name) => `e.${quoteIdent(name)}`;
    const leCol = (name) => `le.${quoteIdent(name)}`;
    const entityClassExpr = entityCols.has("class") ? eCol("class") : "''";
    const classExpr = entityCols.has("class") ? `COALESCE(${leCol("class")}, '')` : "''";
    const rdpsExpr = entityCols.has("rdps") ? `COALESCE(${leCol("rdps")}, 0)` : "0";
    const ndpsExpr = entityCols.has("ndps") ? `COALESCE(${leCol("ndps")}, 0)` : "0";
    const isDeadExpr = entityCols.has("is_dead") ? `COALESCE(${leCol("is_dead")}, 0)` : "0";
    const supportApExpr = entityCols.has("support_ap") ? `COALESCE(${leCol("support_ap")}, 0)` : "0";
    const supportBrandExpr = entityCols.has("support_brand") ? `COALESCE(${leCol("support_brand")}, 0)` : "0";
    const supportIdentityExpr = entityCols.has("support_identity") ? `COALESCE(${leCol("support_identity")}, 0)` : "0";
    const supportHyperExpr = entityCols.has("support_hyper") ? `COALESCE(${leCol("support_hyper")}, 0)` : "0";
    const skillStatsExpr = entityCols.has("skill_stats") ? `COALESCE(${leCol("skill_stats")}, '')` : "''";
    const rdpsDamageGivenExpr = entityCols.has("rdps_damage_given") ? `COALESCE(${leCol("rdps_damage_given")}, 0)` : "0";
    const rdpsDamageReceivedExpr = entityCols.has("rdps_damage_received") ? `COALESCE(${leCol("rdps_damage_received")}, 0)` : "0";
    const rdpsDamageReceivedSupportExpr = entityCols.has("rdps_damage_received_support") ? `COALESCE(${leCol("rdps_damage_received_support")}, 0)` : "0";
    const damageStatsExpr = entityCols.has("damage_stats") ? leCol("damage_stats") : "NULL";
    const skillsExpr = entityCols.has("skills") ? leCol("skills") : "NULL";
    const classIdExpr = entityCols.has("class_id") ? leCol("class_id") : "NULL";
    const gearScoreExpr = entityCols.has("gear_score") ? leCol("gear_score") : "NULL";
    const combatPowerExpr = entityCols.has("combat_power") ? leCol("combat_power") : "NULL";
    const arkPassiveActiveExpr = entityCols.has("ark_passive_active") ? leCol("ark_passive_active") : "NULL";
    const engravingsExpr = entityCols.has("engravings") ? leCol("engravings") : "NULL";
    const specExpr = entityCols.has("spec") ? leCol("spec") : "NULL";
    const arkPassiveDataExpr = entityCols.has("ark_passive_data") ? leCol("ark_passive_data") : "NULL";
    const gearHashExpr = entityCols.has("gear_hash") ? leCol("gear_hash") : "NULL";
    const loadoutHashExpr = entityCols.has("loadout_hash") ? leCol("loadout_hash") : "NULL";
    const entityUnbuffedDamageExpr = entityCols.has("unbuffed_damage") ? `COALESCE(${leCol("unbuffed_damage")}, 0)` : "0";
    const entityUnbuffedDpsExpr = entityCols.has("unbuffed_dps") ? `COALESCE(${leCol("unbuffed_dps")}, 0)` : "0";
    const supportSpecList = sqlStringList(SUPPORT_DPS_PROFILE_SPEC_KEYS);
    const supportClassKeyExpr = (alias) => `LOWER(REPLACE(COALESCE(${alias}.${quoteIdent("class")}, ''), ' ', ''))`;
    const supportClassPredicate = (alias) => (
      `${supportClassKeyExpr(alias)} IN ('bard', 'paladin', 'artist', 'valkyrie', 'holyknight')`
    );
    const supportSpecKeyExpr = (alias) => (
      `LOWER(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${alias}.${quoteIdent("spec")}, ''), ' ', ''), '&nbsp;', ''), '-', ''), '_', ''))`
    );
    const supportMainBuildPredicate = (alias) => entityCols.has("spec")
      ? `${supportSpecKeyExpr(alias)} NOT IN (${supportSpecList})`
      : "1 = 1";
    const contextRoleExpr = (alias) => entityCols.has("class")
      ? `CASE WHEN ${supportClassPredicate(alias)} AND ${supportMainBuildPredicate(alias)} THEN 'support' ELSE 'dps' END`
      : "'dps'";
    const supportRankExpr = entityCols.has("class") && entityCols.has("rdps_damage_given")
      ? `1 + (
          SELECT COUNT(*)
            FROM entity se
           WHERE se.${quoteIdent("encounter_id")} = ep.id
             AND se.${quoteIdent("entity_type")} = 'PLAYER'
             AND ${supportClassPredicate("se")}
             AND ${supportMainBuildPredicate("se")}
             AND COALESCE(se.${quoteIdent("rdps_damage_given")}, 0) > COALESCE(${leCol("rdps_damage_given")}, 0)
        )`
      : "0";
    const supportCountExpr = entityCols.has("class") && entityCols.has("rdps_damage_given")
      ? `(
          SELECT COUNT(*)
            FROM entity se
           WHERE se.${quoteIdent("encounter_id")} = ep.id
             AND se.${quoteIdent("entity_type")} = 'PLAYER'
             AND ${supportClassPredicate("se")}
             AND ${supportMainBuildPredicate("se")}
             AND COALESCE(se.${quoteIdent("rdps_damage_given")}, 0) > 0
        )`
      : "0";

    const sql = `
      WITH eligible AS (
        SELECT ep.id AS id,
               ${tsSql} AS fight_start,
               ${bossSql} AS boss,
               COALESCE(${diffSql}, 'Normal') AS difficulty,
               ${charSql} AS local_player,
               ${durationMsExpr} AS duration_ms,
               COALESCE(${playersSql}, '') AS players,
               ${encounterMiscExpr} AS encounter_misc,
               ${encounterBuffsExpr} AS encounter_buffs,
               ${encounterDebuffsExpr} AS encounter_debuffs,
               ${encounterShieldBuffsExpr} AS encounter_shield_buffs,
               ${encounterTotalDamageExpr} AS encounter_total_damage_dealt,
               ${encounterTopDamageExpr} AS encounter_top_damage_dealt,
               ${encounterTotalDamageTakenExpr} AS encounter_total_damage_taken
        FROM encounter_preview ep
        ${encounterJoin}
        WHERE ${clearedSql} = 1
          AND ${durationMsExpr} > ${MIN_DURATION_MS}
          ${minFightStartFilter}
          AND ${bossSql} IN (${supportedBosses})
          AND ${charSql} IS NOT NULL
          AND ${charSql} != ''
      ),
      player_base AS (
        SELECT ${eCol("encounter_id")} AS encounter_id,
               ${eCol("name")} AS name,
               ep.boss AS boss,
               ep.difficulty AS difficulty,
               LOWER(REPLACE(COALESCE(${entityClassExpr}, ''), ' ', '')) AS class_key,
               ${entityCols.has("spec") ? supportSpecKeyExpr("e") : "''"} AS spec_key,
               ${contextRoleExpr("e")} AS context_role,
               COALESCE(${eCol("dps")}, 0) AS dps,
               ${rdpsDamageGivenExpr.replaceAll("le.", "e.")} AS rdps_damage_given,
               ep.encounter_total_damage_dealt AS encounter_total_damage_dealt,
               CASE WHEN COALESCE(ep.encounter_misc, '') LIKE '%"rdpsValid":true%' THEN 1 ELSE 0 END AS rdps_valid
          FROM entity e
          JOIN eligible ep ON ep.id = ${eCol("encounter_id")}
          WHERE ${eCol("entity_type")} = 'PLAYER'
            AND COALESCE(${eCol("dps")}, 0) > 0
            AND COALESCE(${entityClassExpr}, '') != ''
      ),
      ranked AS (
        SELECT pb.*,
               SUM(pb.dps) OVER (PARTITION BY pb.encounter_id) AS party_dps,
               MAX(pb.dps) OVER (PARTITION BY pb.encounter_id) AS top_dps,
               RANK() OVER (PARTITION BY pb.encounter_id ORDER BY pb.dps DESC) AS damage_rank,
               COUNT(*) OVER (PARTITION BY pb.encounter_id) AS party_count,
               CASE WHEN pb.encounter_total_damage_dealt > 0
                    THEN (pb.rdps_damage_given * 100.0) / pb.encounter_total_damage_dealt
                    ELSE 0
               END AS support_percent_context
          FROM player_base pb
      ),
      dps_context AS (
        SELECT encounter_id,
               name,
               CASE WHEN spec_key != '' THEN COUNT(*) OVER (PARTITION BY boss, difficulty, class_key, spec_key, context_role) ELSE 0 END AS spec_context_sample_count,
               CASE WHEN spec_key != '' THEN PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, spec_key, context_role
                 ORDER BY CASE WHEN party_dps > 0 THEN (dps * 100.0) / party_dps ELSE 0 END
               ) * 100 ELSE 0 END AS spec_damage_share_percentile,
               CASE WHEN spec_key != '' THEN PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, spec_key, context_role
                 ORDER BY CASE WHEN top_dps > 0 THEN (dps * 100.0) / top_dps ELSE 0 END
               ) * 100 ELSE 0 END AS spec_top_damage_proximity_percentile,
               COUNT(*) OVER (PARTITION BY boss, difficulty, class_key, context_role) AS class_context_sample_count,
               PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, context_role
                 ORDER BY CASE WHEN party_dps > 0 THEN (dps * 100.0) / party_dps ELSE 0 END
               ) * 100 AS class_damage_share_percentile,
               PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, context_role
                 ORDER BY CASE WHEN top_dps > 0 THEN (dps * 100.0) / top_dps ELSE 0 END
               ) * 100 AS class_top_damage_proximity_percentile
          FROM ranked
          WHERE context_role = 'dps'
            AND party_dps > 0
            AND top_dps > 0
      ),
      support_context AS (
        SELECT encounter_id,
               name,
               CASE WHEN spec_key != '' THEN COUNT(*) OVER (PARTITION BY boss, difficulty, class_key, spec_key, context_role) ELSE 0 END AS spec_context_sample_count,
               CASE WHEN spec_key != '' THEN PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, spec_key, context_role
                 ORDER BY support_percent_context
               ) * 100 ELSE 0 END AS spec_support_percentile,
               COUNT(*) OVER (PARTITION BY boss, difficulty, class_key, context_role) AS class_context_sample_count,
               PERCENT_RANK() OVER (
                 PARTITION BY boss, difficulty, class_key, context_role
                 ORDER BY support_percent_context
               ) * 100 AS class_support_percentile
          FROM ranked
          WHERE context_role = 'support'
            AND rdps_valid = 1
            AND support_percent_context > 0
      )
      SELECT ep.id,
             ep.fight_start,
             ep.boss,
             ep.difficulty,
             ep.local_player,
             ep.duration_ms,
             ep.players,
             ep.encounter_misc,
              ep.encounter_buffs,
              ep.encounter_debuffs,
              ep.encounter_shield_buffs,
              ${classExpr},
              r.dps,
              ${rdpsExpr},
              ${ndpsExpr},
              ${isDeadExpr},
              ${supportApExpr},
              ${supportBrandExpr},
              ${supportIdentityExpr},
              ${supportHyperExpr},
              ${skillStatsExpr},
              ${rdpsDamageGivenExpr},
              ${rdpsDamageReceivedExpr},
              ${rdpsDamageReceivedSupportExpr},
              ${damageStatsExpr},
              ${skillsExpr},
              r.party_dps,
              r.damage_rank,
              r.party_count,
              ${supportRankExpr},
              ${supportCountExpr},
              ${classIdExpr},
              ${gearScoreExpr},
              ${combatPowerExpr},
              ${arkPassiveActiveExpr},
              ${engravingsExpr},
              ${specExpr},
              ${arkPassiveDataExpr},
              ${gearHashExpr},
              ${loadoutHashExpr},
              ${entityUnbuffedDamageExpr},
              ${entityUnbuffedDpsExpr},
              ep.encounter_total_damage_dealt,
              ep.encounter_top_damage_dealt,
              ep.encounter_total_damage_taken,
              COALESCE(dps_context.spec_context_sample_count, 0),
              COALESCE(dps_context.spec_damage_share_percentile, 0),
              COALESCE(dps_context.spec_top_damage_proximity_percentile, 0),
              COALESCE(dps_context.class_context_sample_count, 0),
              COALESCE(dps_context.class_damage_share_percentile, 0),
              COALESCE(dps_context.class_top_damage_proximity_percentile, 0),
              COALESCE(support_context.spec_context_sample_count, 0),
              COALESCE(support_context.spec_support_percentile, 0),
              COALESCE(support_context.class_context_sample_count, 0),
              COALESCE(support_context.class_support_percentile, 0)
      FROM eligible ep
      JOIN entity le ON le.${quoteIdent("encounter_id")} = ep.id AND le.${quoteIdent("name")} = ep.local_player
      JOIN ranked r ON r.encounter_id = ep.id AND r.name = ep.local_player
      LEFT JOIN dps_context ON dps_context.encounter_id = ep.id AND dps_context.name = ep.local_player
      LEFT JOIN support_context ON support_context.encounter_id = ep.id AND support_context.name = ep.local_player
      WHERE le.${quoteIdent("entity_type")} = 'PLAYER'
      ORDER BY ep.fight_start DESC;
    `;

    const rows = [];
    await sqlite3.exec(db, sql, (row) => {
      const localName = row[4];
      const rosterInfo = rosterByName.get(normalizeName(localName));
      if (!rosterInfo) return;
      rows.push({
        encounterId: row[0],
        fightStart: Number(row[1]) || 0,
        boss: row[2] || "",
        difficulty: row[3] || "Normal",
        localPlayer: localName || "",
        durationMs: Number(row[5]) || 0,
        players: row[6] || "",
        encounterMiscRaw: row[7] || "",
        encounterBuffsRaw: row[8] || null,
        encounterDebuffsRaw: row[9] || null,
        encounterShieldBuffsRaw: row[10] || null,
        className: rosterInfo.class || row[11] || "",
        dps: Number(row[12]) || 0,
        rdps: Number(row[13]) || 0,
        ndps: Number(row[14]) || 0,
        isDead: Number(row[15]) ? 1 : 0,
        supportAp: Number(row[16]) || 0,
        supportBrand: Number(row[17]) || 0,
        supportIdentity: Number(row[18]) || 0,
        supportHyper: Number(row[19]) || 0,
        skillStats: row[20] || "",
        rdpsDamageGiven: Number(row[21]) || 0,
        rdpsDamageReceived: Number(row[22]) || 0,
        rdpsDamageReceivedSupport: Number(row[23]) || 0,
        damageStatsRaw: row[24] || null,
        skillsRaw: row[25] || null,
        partyDps: Number(row[26]) || 0,
        damageRank: Number(row[27]) || 0,
        partyCount: Number(row[28]) || 0,
        supporterRank: Number(row[29]) || 0,
        supporterCount: Number(row[30]) || 0,
        classId: Number(row[31]) || 0,
        gearScore: Number(row[32]) || 0,
        combatPower: Number(row[33]) || 0,
        arkPassiveActive: row[34] === null || row[34] === undefined ? null : Number(row[34]) ? 1 : 0,
        engravingsRaw: row[35] || "",
        spec: row[36] || "",
        arkPassiveDataRaw: row[37] || "",
        gearHash: row[38] || "",
        loadoutHash: row[39] || "",
        entityUnbuffedDamage: Number(row[40]) || 0,
        entityUnbuffedDps: Number(row[41]) || 0,
        encounterTotalDamageDealt: Number(row[42]) || 0,
        encounterTopDamageDealt: Number(row[43]) || 0,
        encounterTotalDamageTaken: Number(row[44]) || 0,
        dpsContextSpecSampleCount: Number(row[45]) || 0,
        dpsContextSpecDamageSharePercentile: Number(row[46]) || 0,
        dpsContextSpecTopDamageProximityPercentile: Number(row[47]) || 0,
        dpsContextClassSampleCount: Number(row[48]) || 0,
        dpsContextClassDamageSharePercentile: Number(row[49]) || 0,
        dpsContextClassTopDamageProximityPercentile: Number(row[50]) || 0,
        supportContextSpecSampleCount: Number(row[51]) || 0,
        supportContextSpecPercentile: Number(row[52]) || 0,
        supportContextClassSampleCount: Number(row[53]) || 0,
        supportContextClassPercentile: Number(row[54]) || 0,
        accountName: rosterInfo.accountName,
        itemLevel: rosterInfo.itemLevel,
      });
    });
    await enrichProfileRows(rows);
    return rows.filter(isModernProfileRow);
  });
}

function loadStoredProfileSession(discordId) {
  try {
    const raw = localStorage.getItem(PROFILE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.discordId !== discordId) return null;
    if (Number(parsed.expSec) < Math.floor(Date.now() / 1000) + 60) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredProfileSession(session) {
  try {
    localStorage.setItem(PROFILE_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Local storage can be disabled. In-memory caller state still works.
  }
}

async function ensureProfileSession({ discordId, localToken, renderStatus }) {
  const stored = loadStoredProfileSession(discordId);
  if (stored?.profileToken) return stored;
  if (!localToken) throw new Error(t("profileSync.localTokenUnavailable"));

  renderStatus?.("info", t("profileSync.sessionPreparing"));
  const resp = await fetch("/api/local-sync/profile-session", {
    method: "POST",
    headers: { Authorization: `Bearer ${localToken}` },
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.ok || !data.profileToken) {
    throw new Error(data?.error || `profile session failed HTTP ${resp.status}`);
  }
  const session = {
    discordId,
    profileToken: data.profileToken,
    expSec: data.expSec,
  };
  saveStoredProfileSession(session);
  return session;
}

async function sendProfileSnapshot(snapshot, session) {
  const resp = await fetch("/api/raid-profile-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.profileToken}`,
    },
    body: JSON.stringify(snapshot),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || `profile sync failed HTTP ${resp.status}`);
  }
  return data;
}

export function stopProfileAutoSync() {
  if (profileSyncTimer) {
    clearInterval(profileSyncTimer);
    profileSyncTimer = null;
  }
}

function formatSnapshotPercent({ written, total }) {
  const totalBytes = Number(total) || 0;
  if (totalBytes <= 0) return "0";
  return Math.min(100, Math.max(0, (Number(written) || 0) / totalBytes * 100)).toFixed(1);
}

function formatSnapshotGb(total) {
  return (Number(total || 0) / 1e9).toFixed(1);
}

async function getStableProfileScanFile(file, renderStatus) {
  if (stableProfileSourceFile === file && stableProfileSnapshotFile) {
    return stableProfileSnapshotFile;
  }

  let lastStatusMs = 0;
  const result = await createStableFileSnapshot(file, {
    onProgress(event) {
      if (!renderStatus) return;
      const now = Date.now();
      if (event.phase === "starting") {
        renderStatus("info", "Creating a stable encounters.db snapshot before profile scan...");
        lastStatusMs = now;
        return;
      }
      if (event.phase === "copying") {
        if (now - lastStatusMs < 1000 && Number(event.written) < Number(event.total)) return;
        lastStatusMs = now;
        renderStatus(
          "info",
          `Copying encounters.db snapshot... ${formatSnapshotPercent(event)}% / ~${formatSnapshotGb(event.total)} GB`
        );
        return;
      }
      if (event.phase === "ready") {
        renderStatus("info", "Snapshot ready, starting profile scan...");
      }
    },
  });

  if (!result.snapshot) {
    renderStatus?.("warn", "Browser storage snapshot unavailable; if scanning fails, pick a static copied file.");
    return result.file;
  }
  stableProfileSourceFile = file;
  stableProfileSnapshotFile = result.file;
  return stableProfileSnapshotFile;
}

async function runProfileSnapshotSync({
  file,
  getDiscordId,
  getLocalToken,
  getRosterAccounts,
  renderStatus,
  reason = "auto",
  minFightStartMs = 0,
} = {}) {
  if (profileSyncInFlight) {
    return { ok: false, skipped: "in-flight" };
  }
  const discordId = getDiscordId?.();
  if (!file || !discordId) {
    return { ok: false, skipped: "missing-context" };
  }
  profileSyncInFlight = true;
  try {
    const rosterAccounts = await getRosterAccounts?.();
    if (!Array.isArray(rosterAccounts) || rosterAccounts.length === 0) {
      renderStatus?.("warn", t("profileSync.waitingRoster"));
      return { ok: false, skipped: "no-roster" };
    }
    const session = await ensureProfileSession({
      discordId,
      localToken: getLocalToken?.(),
      renderStatus,
    });
    const scanFile = Number(minFightStartMs) > 0
      ? file
      : await getStableProfileScanFile(file, renderStatus);
    renderStatus?.("info", reason === "initial" ? t("profileSync.scanning") : t("profileSync.checking"));
    // A multi-GB encounters.db scan runs for many seconds inside a single
    // SQLite query with no natural progress event. Tick an elapsed counter
    // (the asyncify VFS yields between chunk reads, so the DOM repaints) so
    // the user can see the scan is alive rather than hung.
    const scanStartMs = Date.now();
    const scanGb = (Number(scanFile?.size) / 1e9).toFixed(1);
    let scanHeartbeat = null;
    if (renderStatus) {
      scanHeartbeat = setInterval(() => {
        const secs = Math.floor((Date.now() - scanStartMs) / 1000);
        renderStatus("info", t("profileSync.scanningElapsed", { gb: scanGb, secs }));
      }, 1000);
    }
    let rows;
    try {
      rows = await queryProfileRows(scanFile, rosterAccounts, { minFightStartMs });
    } finally {
      if (scanHeartbeat) clearInterval(scanHeartbeat);
    }
    const weeklyReason = reason === "weekly";
    if (rows.length === 0) {
      renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklyIdle" : "profileSync.idle", { n: 0 }));
      return { ok: true, sent: false, rows: 0 };
    }
    const snapshot = buildProfileSnapshot(rows, rosterAccounts, scanFile, {
      range: minFightStartMs > 0
        ? { type: "weekly", minFightStartMs: Number(minFightStartMs) || 0 }
        : { type: "full" },
      minDurationMs: MIN_DURATION_MS,
    });
    snapshot.encounters = buildProfileEncounterSummaries(rows, scanFile, {
      range: snapshot.criteria?.range,
    });
    const fp = `${discordId}\x1f${fingerprintSnapshot(snapshot)}`;
    if (!fp || fp === lastProfileFingerprint) {
      renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklyIdle" : "profileSync.idle", { n: rows.length }));
      return { ok: true, sent: false, rows: rows.length };
    }
    const result = await sendProfileSnapshot(snapshot, session);
    if (result?.skipped === "empty-profile") {
      renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklyIdle" : "profileSync.idle", { n: rows.length }));
      return { ok: true, sent: false, rows: rows.length, skipped: result.skipped };
    }
    lastProfileFingerprint = fp;
    const chars = result?.totals?.characterCount || 0;
    const logs = result?.totals?.encounterCount || 0;
    renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklySynced" : "profileSync.synced", { logs, chars }));
    return { ok: true, sent: true, rows: rows.length, chars, logs };
  } catch (err) {
    const message = err?.message || String(err);
    renderStatus?.("err", message);
    return { ok: false, error: message };
  } finally {
    profileSyncInFlight = false;
  }
}

export function syncProfileSnapshotOnce(options = {}) {
  return runProfileSnapshotSync({ ...options, reason: options.reason || "manual" });
}

export function startProfileAutoSync({
  file,
  getDiscordId,
  getLocalToken,
  getRosterAccounts,
  renderStatus,
  intervalMs = PROFILE_AUTO_SYNC_INTERVAL_MS,
} = {}) {
  stopProfileAutoSync();
  if (!file) return;

  const run = (reason = "auto") => runProfileSnapshotSync({
    file,
    getDiscordId,
    getLocalToken,
    getRosterAccounts,
    renderStatus,
    reason,
  });

  run("initial");
  profileSyncTimer = setInterval(() => run("auto"), intervalMs);
}
