"use strict";

import {
  loadCatalog,
  BOSS_TO_RAID_GATE,
  getRaidGateForBoss,
  normalizeDifficulty,
} from "/sync/preview-utils.js";
import {
  getArkPassiveNodeMeta,
  getSpecFromArkPassiveNodes,
} from "/sync/ark-passive-data.js";
import { t } from "/sync/i18n.js";
import {
  classifyProfileLogRole,
  roleForProfileClass,
  SUPPORT_DPS_PROFILE_SPEC_KEYS,
} from "/sync/profile-role.js";
import { computeProfileConsistency } from "/sync/profile-metrics.js";
import {
  computeProfileScores as computeScores,
  MIN_CONTEXT_SAMPLE_COUNT,
} from "/sync/profile-score.js";

const WA_SQLITE_VERSION = "1.3.0";
const WA_SQLITE_BASE = `https://cdn.jsdelivr.net/npm/@journeyapps/wa-sqlite@${WA_SQLITE_VERSION}`;
const PROFILE_SESSION_STORAGE_KEY = "artist-profile-sync-session";
const PROFILE_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MAX_PROFILE_ENCOUNTER_SUMMARIES = 5000;
const MIN_DURATION_MS = 180000;
const POSITIONAL_ATTACK_RATE_THRESHOLD = 45;

let profileSyncTimer = null;
let profileSyncInFlight = false;
let lastProfileFingerprint = "";

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
    import("/sync/file-vfs.js"),
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

function average(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function percentile(values, p) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function minPositive(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : 0;
}

function maxPositive(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : 0;
}

function maxPositiveSeries(values) {
  if (!Array.isArray(values)) return 0;
  return maxPositive(values.map((value) => Number(value)));
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function parseCounters(skillStatsRaw) {
  if (!skillStatsRaw) return 0;
  try {
    const stats = typeof skillStatsRaw === "string" ? JSON.parse(skillStatsRaw) : skillStatsRaw;
    return Number(stats?.counters) || 0;
  } catch {
    return 0;
  }
}

function parseSkillStats(skillStatsRaw) {
  if (!skillStatsRaw) {
    return {
      counters: 0,
      casts: 0,
      hits: 0,
      critRate: 0,
      backAttackRate: 0,
      frontAttackRate: 0,
      castsPerMinute: 0,
      hitsPerMinute: 0,
    };
  }
  try {
    const stats = typeof skillStatsRaw === "string" ? JSON.parse(skillStatsRaw) : skillStatsRaw;
    const hits = Number(stats?.hits) || 0;
    return {
      counters: Number(stats?.counters) || 0,
      casts: Number(stats?.casts) || 0,
      hits,
      critRate: hits > 0 ? ((Number(stats?.crits) || 0) / hits) * 100 : 0,
      backAttackRate: hits > 0 ? ((Number(stats?.backAttacks) || 0) / hits) * 100 : 0,
      frontAttackRate: hits > 0 ? ((Number(stats?.frontAttacks) || 0) / hits) * 100 : 0,
    };
  } catch {
    return {
      counters: 0,
      casts: 0,
      hits: 0,
      critRate: 0,
      backAttackRate: 0,
      frontAttackRate: 0,
      castsPerMinute: 0,
      hitsPerMinute: 0,
    };
  }
}

function parseSkillBreakdown(skillsRaw, totalDamage) {
  if (!skillsRaw || !totalDamage) {
    return {
      skillCount: 0,
      topSkillShare: 0,
      topSkills: [],
    };
  }

  const skills = skillsRaw && typeof skillsRaw === "object" && !ArrayBuffer.isView(skillsRaw)
    ? skillsRaw
    : null;
  const entries = [];
  const source = skills || {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    const damage = Number(value.totalDamage) || 0;
    const hits = Number(value.hits) || 0;
    if (damage <= 0 || hits <= 0) continue;
    const name = String(value.name || key || "Unknown").slice(0, 80);
    entries.push({
      id: String(value.id || key || "").slice(0, 32),
      name,
      damage,
      share: (damage / totalDamage) * 100,
      casts: Number(value.casts) || 0,
      hits,
      critRate: hits > 0 ? ((Number(value.crits) || 0) / hits) * 100 : 0,
      backAttackRate: hits > 0 ? ((Number(value.backAttacks) || 0) / hits) * 100 : 0,
      frontAttackRate: hits > 0 ? ((Number(value.frontAttacks) || 0) / hits) * 100 : 0,
      stagger: Number(value.stagger) || 0,
      isHyperAwakening: !!value.isHyperAwakening,
    });
  }
  entries.sort((a, b) => b.damage - a.damage || a.name.localeCompare(b.name));
  return {
    skillCount: entries.length,
    topSkillShare: entries[0]?.share || 0,
    topSkills: entries.slice(0, 8),
  };
}

function classifyAttackStyle(backRate, frontRate) {
  const back = Number(backRate) || 0;
  const front = Number(frontRate) || 0;
  if (back >= POSITIONAL_ATTACK_RATE_THRESHOLD && back >= front) return "back";
  if (front >= POSITIONAL_ATTACK_RATE_THRESHOLD) return "front";
  return "hit_master";
}

function classifySupporterTier(percent) {
  const n = Number(percent) || 0;
  if (n >= 25) return "radiant";
  if (n >= 15) return "noble";
  if (n > 0) return "supporter";
  return "none";
}

function selectContextPercentiles(row, role) {
  if (role === "support") {
    const specSamples = Number(row.supportContextSpecSampleCount) || 0;
    const classSamples = Number(row.supportContextClassSampleCount) || 0;
    const useSpec = specSamples >= MIN_CONTEXT_SAMPLE_COUNT;
    const useClass = !useSpec && classSamples >= MIN_CONTEXT_SAMPLE_COUNT;
    if (!useSpec && !useClass) {
      return {
        contextSource: "none",
        contextSampleCount: 0,
        contextDamageSharePercentile: 0,
        contextTopDamageProximityPercentile: 0,
        contextSupportPercentile: 0,
        contextPerformancePercentile: 0,
      };
    }
    const percentile = clampScore(useSpec ? row.supportContextSpecPercentile : row.supportContextClassPercentile);
    return {
      contextSource: useSpec ? "spec" : "class",
      contextSampleCount: useSpec ? specSamples : classSamples,
      contextDamageSharePercentile: 0,
      contextTopDamageProximityPercentile: 0,
      contextSupportPercentile: round1(percentile),
      contextPerformancePercentile: round1(percentile),
    };
  }

  const specSamples = Number(row.dpsContextSpecSampleCount) || 0;
  const classSamples = Number(row.dpsContextClassSampleCount) || 0;
  const useSpec = specSamples >= MIN_CONTEXT_SAMPLE_COUNT;
  const useClass = !useSpec && classSamples >= MIN_CONTEXT_SAMPLE_COUNT;
  if (!useSpec && !useClass) {
    return {
      contextSource: "none",
      contextSampleCount: 0,
      contextDamageSharePercentile: 0,
      contextTopDamageProximityPercentile: 0,
      contextSupportPercentile: 0,
      contextPerformancePercentile: 0,
    };
  }
  const damageSharePercentile = clampScore(
    useSpec ? row.dpsContextSpecDamageSharePercentile : row.dpsContextClassDamageSharePercentile
  );
  const topDamageProximityPercentile = clampScore(
    useSpec ? row.dpsContextSpecTopDamageProximityPercentile : row.dpsContextClassTopDamageProximityPercentile
  );
  return {
    contextSource: useSpec ? "spec" : "class",
    contextSampleCount: useSpec ? specSamples : classSamples,
    contextDamageSharePercentile: round1(damageSharePercentile),
    contextTopDamageProximityPercentile: round1(topDamageProximityPercentile),
    contextSupportPercentile: 0,
    contextPerformancePercentile: round1(damageSharePercentile * 0.55 + topDamageProximityPercentile * 0.45),
  };
}

function parseEncounterMisc(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsonObject(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function sumDeathDowntimeMs(stats) {
  const deathInfo = Array.isArray(stats?.deathInfo) ? stats.deathInfo : [];
  return deathInfo.reduce((sum, entry) => {
    const deadFor = Number(entry?.deadFor) || 0;
    return sum + Math.max(0, deadFor);
  }, 0);
}

function extractIntermissionMs(misc, durationMs) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const start = Number(misc?.intermissionStart);
  const end = Number(misc?.intermissionEnd);
  if (!duration || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(duration, Math.max(0, end - start));
}

function cleanBuildName(value) {
  return stripMarkup(value).slice(0, 80);
}

function summarizeEngravings(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed
      .map((name, index) => ({
        id: "",
        name: cleanBuildName(name),
        level: 0,
        isClass: index === 0,
      }))
      .filter((entry) => entry.name)
      .slice(0, 8);
  }
  const entries = [
    ...(Array.isArray(parsed.classEngravings) ? parsed.classEngravings : []),
    ...(Array.isArray(parsed.otherEngravings) ? parsed.otherEngravings : []),
  ];
  return entries
    .map((entry) => ({
      id: String(entry?.id || "").slice(0, 32),
      name: cleanBuildName(entry?.name),
      level: Number(entry?.level) || 0,
      isClass: (parsed.classEngravings || []).includes(entry),
    }))
    .filter((entry) => entry.name)
    .slice(0, 8);
}

function summarizeArkPassive(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const summarizeNode = (node) => {
    const id = Number(node?.id) || 0;
    const level = Number(node?.lv ?? node?.level) || 0;
    if (!id || !level) return null;
    const meta = getArkPassiveNodeMeta(id);
    const pointsPerLevel = Number(meta?.pointsPerLevel) || 0;
    return {
      id,
      level,
      name: cleanBuildName(meta?.name),
      tier: meta ? Number(meta.tier) + 1 : 0,
      position: meta ? Number(meta.position) : 0,
      maxLevel: Number(meta?.maxLevel) || 0,
      points: pointsPerLevel ? level * pointsPerLevel : 0,
    };
  };
  const summarizeTree = (name) => {
    const nodes = (Array.isArray(parsed[name]) ? parsed[name] : [])
      .map(summarizeNode)
      .filter(Boolean);
    const tree = {
      count: nodes.length,
      points: nodes.reduce((sum, node) => sum + (Number(node.level) || 0), 0),
      spentPoints: nodes.reduce((sum, node) => sum + (Number(node.points) || 0), 0),
      nodes,
    };
    if (name === "enlightenment") tree.spec = getSpecFromArkPassiveNodes(nodes);
    return tree;
  };
  return {
    evolution: summarizeTree("evolution"),
    enlightenment: summarizeTree("enlightenment"),
    leap: summarizeTree("leap"),
  };
}

function buildVariantKey(row) {
  const identity = buildVariantIdentity(row);
  return identity.known ? identity.key : "";
}

function buildVariantIdentity(row) {
  const spec = cleanBuildName(row?.arkPassive?.enlightenment?.spec || row?.spec || "");
  if (spec) return { key: `spec:${normalizeName(spec)}`, name: spec, known: true };
  const classEngraving = (row?.engravings || []).find((entry) => entry?.isClass && entry?.name);
  if (classEngraving?.name) {
    const name = cleanBuildName(classEngraving.name);
    return { key: `class:${normalizeName(name)}`, name, known: true };
  }
  return { key: "unknown", name: "Unknown build", known: false };
}

function buildVariantName(row) {
  return buildVariantIdentity(row).name;
}

function countUnclassifiedBuildRows(rows) {
  return (rows || []).filter((row) => !buildVariantIdentity(row).known).length;
}

function summarizeBuildVariants(rows, { limit = 6 } = {}) {
  const groups = new Map();
  let hasKnownVariant = false;
  for (const row of rows || []) {
    const identity = buildVariantIdentity(row);
    if (identity.known) hasKnownVariant = true;
    if (!groups.has(identity.key)) groups.set(identity.key, { identity, rows: [] });
    groups.get(identity.key).rows.push(row);
  }
  return [...groups.values()]
    .filter((group) => group.identity.known || !hasKnownVariant)
    .map((group) => {
      const groupRows = group.rows;
      const latest = groupRows.reduce((best, row) =>
        (Number(row.fightStart) || 0) > (Number(best.fightStart) || 0) ? row : best
      , groupRows[0]);
      const dps = groupRows.map((row) => row.dps);
      return {
        name: group.identity.name || buildVariantName(latest),
        spec: group.identity.name || buildVariantName(latest),
        role: latest.logRole || latest.classRole || "unknown",
        encounters: groupRows.length,
        firstFightStart: minPositive(groupRows.map((row) => row.fightStart)),
        lastFightStart: maxPositive(groupRows.map((row) => row.fightStart)),
        avgDps: Math.round(average(dps)),
        medianDps: Math.round(percentile(dps, 50)),
        p90Dps: Math.round(percentile(dps, 90)),
        avgDamageShare: round1(average(groupRows.map((row) => row.damageShare))),
        avgTopDamageProximity: round1(average(groupRows.map((row) => row.topDamageProximity))),
        avgContextPerformancePercentile: round1(average(groupRows.map((row) => row.contextPerformancePercentile))),
        avgCritRate: round1(average(groupRows.map((row) => row.critRate))),
        avgBackAttackDamageShare: round1(average(groupRows.map((row) => row.backAttackDamageShare))),
        avgFrontAttackDamageShare: round1(average(groupRows.map((row) => row.frontAttackDamageShare))),
      };
    })
    .sort((a, b) =>
      b.encounters - a.encounters ||
      (b.lastFightStart || 0) - (a.lastFightStart || 0) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, limit);
}

function extractContributionMetrics(misc, localPlayer, damageDealt) {
  const splits = Array.isArray(misc?.contributionSplits) ? misc.contributionSplits : [];
  const localKey = normalizeName(localPlayer);
  let localSplit = null;
  let synergyGiven = 0;
  for (const split of splits) {
    const splitName = normalizeName(split?.name);
    const damageByName = split?.damageSplitByName || {};
    if (splitName === localKey) localSplit = split;
    for (const [sourceName, amount] of Object.entries(damageByName)) {
      if (normalizeName(sourceName) === localKey && splitName !== localKey) {
        synergyGiven += Number(amount) || 0;
      }
    }
  }

  let synergyReceived = 0;
  for (const [sourceName, amount] of Object.entries(localSplit?.damageSplitByName || {})) {
    if (normalizeName(sourceName) !== localKey) synergyReceived += Number(amount) || 0;
  }

  return {
    partyNumber: Number(localSplit?.partyNumber),
    synergyGiven,
    synergyReceived,
    synergyReceivedShare: damageDealt > 0 ? (synergyReceived / damageDealt) * 100 : 0,
  };
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSourceName(meta, id) {
  const source = meta?.source || {};
  const rawName = source.name || source.skill?.name || id || "Unknown";
  return stripMarkup(rawName).slice(0, 80) || "Unknown";
}

function cleanSourceCategory(meta) {
  return normalizeName(meta?.buffCategory || meta?.category || "unknown").replace(/\s+/g, "_") || "unknown";
}

function cleanSourceTarget(meta) {
  return String(meta?.target || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
}

function normalizeAmountMap(raw) {
  if (!raw || typeof raw !== "object" || ArrayBuffer.isView(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const amount = Number(value) || 0;
    if (amount <= 0) continue;
    out[String(key)] = (out[String(key)] || 0) + amount;
  }
  return out;
}

function combineAmountMaps(...maps) {
  const out = {};
  for (const map of maps) {
    const normalized = normalizeAmountMap(map);
    for (const [key, amount] of Object.entries(normalized)) {
      out[key] = (out[key] || 0) + amount;
    }
  }
  return out;
}

function sourceMatches(meta, { category, targets, categories, allowUnknown = false } = {}) {
  if (!meta) return !!allowUnknown;
  const effectCategory = normalizeName(meta.category);
  const sourceCategory = cleanSourceCategory(meta);
  const target = cleanSourceTarget(meta);
  if (category && effectCategory !== normalizeName(category)) return false;
  if (targets && !targets.includes(target)) return false;
  if (categories && !categories.includes(sourceCategory)) return false;
  return true;
}

function sourceShare(amountMap, metadataMap, denominator, opts = {}) {
  const base = Number(denominator) || 0;
  if (base <= 0) return 0;
  let amount = 0;
  for (const [id, value] of Object.entries(normalizeAmountMap(amountMap))) {
    const meta = metadataMap?.[id] || null;
    if (!sourceMatches(meta, opts)) continue;
    amount += value;
  }
  return (amount / base) * 100;
}

function summarizeSourceMap(amountMap, metadataMap, denominator, limit = 6, opts = {}) {
  const entries = [];
  const normalized = normalizeAmountMap(amountMap);
  const base = Number(denominator) || 0;
  for (const [id, amount] of Object.entries(normalized)) {
    const meta = metadataMap?.[id] || null;
    if (!sourceMatches(meta, opts)) continue;
    entries.push({
      id: String(id).slice(0, 32),
      name: cleanSourceName(meta, id),
      category: cleanSourceCategory(meta),
      target: cleanSourceTarget(meta),
      amount,
      share: base > 0 ? (amount / base) * 100 : 0,
    });
  }
  return entries
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function bytesFromValue(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function parseMaybeGzipJson(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  const bytes = bytesFromValue(value);
  if (!bytes) return null;

  try {
    const text = new TextDecoder("utf-8").decode(bytes);
    if (text.trimStart().startsWith("{")) return JSON.parse(text);
  } catch {
    // Fall through to gzip decode.
  }

  if (typeof DecompressionStream !== "function" || typeof Blob !== "function") {
    return null;
  }

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function enrichProfileRows(rows) {
  await Promise.all(rows.map(async (row) => {
    const stats = await parseMaybeGzipJson(row.damageStatsRaw);
    const skills = await parseMaybeGzipJson(row.skillsRaw);
    const encounterBuffs = await parseMaybeGzipJson(row.encounterBuffsRaw);
    const encounterDebuffs = await parseMaybeGzipJson(row.encounterDebuffsRaw);
    const encounterShieldBuffs = await parseMaybeGzipJson(row.encounterShieldBuffsRaw);
    const misc = parseEncounterMisc(row.encounterMiscRaw);
    const skill = parseSkillStats(row.skillStats);
    row.hasDamageStats = !!stats;
    row.damageStatsRaw = undefined;
    row.skillsRaw = undefined;
    row.encounterMiscRaw = undefined;
    row.encounterBuffsRaw = undefined;
    row.encounterDebuffsRaw = undefined;
    row.encounterShieldBuffsRaw = undefined;
    row.engravings = summarizeEngravings(row.engravingsRaw);
    row.arkPassive = summarizeArkPassive(row.arkPassiveDataRaw);
    row.engravingsRaw = undefined;
    row.arkPassiveDataRaw = undefined;
    row.intermissionMs = extractIntermissionMs(misc, row.durationMs);
    row.activeDurationMs = Math.max(0, (Number(row.durationMs) || 0) - row.intermissionMs);
    row.activeTimeRate = row.durationMs > 0 ? (row.activeDurationMs / row.durationMs) * 100 : 0;
    const durationMin = row.durationMs > 0 ? row.durationMs / 60000 : 0;
    const activeDurationMin = row.activeDurationMs > 0 ? row.activeDurationMs / 60000 : durationMin;
    row.rdpsValid = misc?.rdpsValid === true;
    const deathInfoCount = Array.isArray(stats?.deathInfo) ? stats.deathInfo.length : 0;
    const parsedDeaths = Number(stats?.deaths) || 0;
    row.deathCount = Math.max(parsedDeaths, deathInfoCount, row.isDead ? 1 : 0);
    row.isDead = row.deathCount > 0 ? 1 : row.isDead;
    row.deadTimeMs = sumDeathDowntimeMs(stats);
    row.deadTimePerMinute = activeDurationMin > 0 ? row.deadTimeMs / activeDurationMin : 0;
    row.deadTimeRate = row.durationMs > 0 ? (row.deadTimeMs / row.durationMs) * 100 : 0;
    row.counters = skill.counters;
    row.casts = skill.casts;
    row.hits = skill.hits;
    row.critRate = skill.critRate;
    row.backAttackRate = skill.backAttackRate;
    row.frontAttackRate = skill.frontAttackRate;
    row.castsPerMinute = activeDurationMin > 0 ? skill.casts / activeDurationMin : 0;
    row.hitsPerMinute = activeDurationMin > 0 ? skill.hits / activeDurationMin : 0;
    row.damageDealt = Number(stats?.damageDealt) || Math.round(row.dps * durationMin * 60) || 0;
    row.peak10sDps = Math.round(maxPositiveSeries(stats?.dpsRolling10sAvg));
    row.burstRatio = row.dps > 0 && row.peak10sDps > 0 ? row.peak10sDps / row.dps : 0;
    row.topDamageProximity = row.encounterTopDamageDealt > 0
      ? Math.min(100, (row.damageDealt / row.encounterTopDamageDealt) * 100)
      : row.damageRank === 1 ? 100 : 0;
    row.critDamageShare = row.damageDealt > 0
      ? ((Number(stats?.critDamage) || Number(stats?.damageDoneFromCrits) || 0) / row.damageDealt) * 100
      : 0;
    row.backAttackDamageShare = row.damageDealt > 0
      ? ((Number(stats?.backAttackDamage) || 0) / row.damageDealt) * 100
      : 0;
    row.frontAttackDamageShare = row.damageDealt > 0
      ? ((Number(stats?.frontAttackDamage) || 0) / row.damageDealt) * 100
      : 0;
    row.positionalDamageShare = row.backAttackDamageShare + row.frontAttackDamageShare;
    row.attackStyle = classifyAttackStyle(row.backAttackDamageShare || row.backAttackRate, row.frontAttackDamageShare || row.frontAttackRate);
    const skillBreakdown = parseSkillBreakdown(skills, row.damageDealt);
    row.skillCount = skillBreakdown.skillCount;
    row.topSkillShare = skillBreakdown.topSkillShare;
    row.topSkills = skillBreakdown.topSkills;
    row.damageTaken = Number(stats?.damageTaken) || 0;
    row.damageTakenShareValid = row.encounterTotalDamageTaken > 0;
    row.damageTakenShare = row.encounterTotalDamageTaken > 0
      ? (row.damageTaken / row.encounterTotalDamageTaken) * 100
      : 0;
    row.damageAbsorbed = Number(stats?.damageAbsorbed) || 0;
    row.shieldsReceived = Number(stats?.shieldsReceived) || 0;
    row.stagger = Number(stats?.stagger) || 0;
    row.hyperAwakeningDamage = Number(stats?.hyperAwakeningDamage) || 0;
    row.unbuffedDamage = Number(stats?.unbuffedDamage) || row.entityUnbuffedDamage || 0;
    row.unbuffedDps = row.entityUnbuffedDps || (durationMin > 0 ? row.unbuffedDamage / (durationMin * 60) : 0);
    row.buffedBySupport = Number(stats?.buffedBySupport) || 0;
    row.debuffedBySupport = Number(stats?.debuffedBySupport) || 0;
    const incapacitations = Array.isArray(stats?.incapacitations) ? stats.incapacitations.length : 0;
    row.incapacitations = incapacitations;
    row.damageTakenPerMinute = activeDurationMin > 0 ? row.damageTaken / activeDurationMin : 0;
    row.damageAbsorbedPerMinute = activeDurationMin > 0 ? row.damageAbsorbed / activeDurationMin : 0;
    row.shieldReceivedPerMinute = activeDurationMin > 0 ? row.shieldsReceived / activeDurationMin : 0;
    row.staggerPerMinute = activeDurationMin > 0 ? row.stagger / activeDurationMin : 0;
    row.incapacitationsPerMinute = activeDurationMin > 0 ? row.incapacitations / activeDurationMin : 0;
    row.hyperShare = row.damageDealt > 0 ? (row.hyperAwakeningDamage / row.damageDealt) * 100 : 0;
    row.unbuffedShare = row.damageDealt > 0 ? (row.unbuffedDamage / row.damageDealt) * 100 : 0;
    row.supportBuffedShare = row.damageDealt > 0 ? (row.buffedBySupport / row.damageDealt) * 100 : 0;
    row.supportDebuffedShare = row.damageDealt > 0 ? (row.debuffedBySupport / row.damageDealt) * 100 : 0;
    const shieldsGiven = Number(stats?.shieldsGiven) || 0;
    const absorbedOnOthers = Number(stats?.damageAbsorbedOnOthers) || 0;
    row.shieldsGiven = shieldsGiven;
    row.damageAbsorbedOnOthers = absorbedOnOthers;
    row.protection = shieldsGiven + absorbedOnOthers;
    row.protectionPerMinute = activeDurationMin > 0 ? row.protection / activeDurationMin : 0;
    const buffedBy = normalizeAmountMap(stats?.buffedBy);
    const debuffedBy = normalizeAmountMap(stats?.debuffedBy);
    const shieldGivenBy = combineAmountMaps(stats?.shieldsGivenBy, stats?.damageAbsorbedOnOthersBy);
    const shieldReceivedBy = combineAmountMaps(stats?.shieldsReceivedBy, stats?.damageAbsorbedBy);
    row.partyBuffedShare = sourceShare(buffedBy, encounterBuffs, row.damageDealt, {
      category: "buff",
      targets: ["PARTY"],
    });
    row.selfBuffedShare = sourceShare(buffedBy, encounterBuffs, row.damageDealt, {
      category: "buff",
      targets: ["SELF"],
    });
    row.partyDebuffedShare = sourceShare(debuffedBy, encounterDebuffs, row.damageDealt, {
      category: "debuff",
      targets: ["PARTY"],
    });
    row.battleItemDebuffedShare = sourceShare(debuffedBy, encounterDebuffs, row.damageDealt, {
      category: "debuff",
      categories: ["battleitem"],
    });
    row.topBuffSources = summarizeSourceMap(buffedBy, encounterBuffs, row.damageDealt, 8, {
      category: "buff",
      targets: ["PARTY", "SELF"],
      allowUnknown: true,
    });
    row.topDebuffSources = summarizeSourceMap(debuffedBy, encounterDebuffs, row.damageDealt, 8, {
      category: "debuff",
      targets: ["PARTY", "SELF"],
      allowUnknown: true,
    });
    row.topShieldGivenSources = summarizeSourceMap(shieldGivenBy, encounterShieldBuffs, row.protection, 8, {
      category: "buff",
      allowUnknown: true,
    });
    row.topShieldReceivedSources = summarizeSourceMap(
      shieldReceivedBy,
      encounterShieldBuffs,
      row.shieldsReceived + row.damageAbsorbed,
      8,
      { category: "buff", allowUnknown: true }
    );
    row.rdpsDamageGivenPerMinute = activeDurationMin > 0 ? row.rdpsDamageGiven / activeDurationMin : 0;
    row.rdpsDamageReceivedSupportPerMinute = activeDurationMin > 0 ? row.rdpsDamageReceivedSupport / activeDurationMin : 0;
    const contribution = extractContributionMetrics(misc, row.localPlayer, row.damageDealt);
    row.partyNumber = Number.isFinite(contribution.partyNumber) ? contribution.partyNumber : null;
    row.synergyGiven = contribution.synergyGiven;
    row.synergyReceived = contribution.synergyReceived;
    row.synergyGivenPerMinute = activeDurationMin > 0 ? contribution.synergyGiven / activeDurationMin : 0;
    row.synergyReceivedShare = contribution.synergyReceivedShare;
    row.damageShare = row.partyDps > 0 ? (row.dps / row.partyDps) * 100 : 0;
    row.classRole = roleForProfileClass(row.className);
    row.logRole = classifyProfileLogRole(row);
    row.encounterDamageDealt = row.encounterTotalDamageDealt ||
      (row.partyDps > 0 && row.durationMs > 0 ? Math.round(row.partyDps * (row.durationMs / 1000)) : 0);
    const supportLog = row.classRole === "support" && row.logRole === "support" && row.rdpsValid;
    row.supporterRank = supportLog ? Math.max(0, Number(row.supporterRank) || 0) : 0;
    row.supporterCount = supportLog ? Math.max(0, Number(row.supporterCount) || 0) : 0;
    row.supporterTop = row.supporterCount > 1 && row.supporterRank === 1 ? 1 : 0;
    row.supporterDamageGiven = supportLog ? Math.max(0, Number(row.rdpsDamageGiven) || 0) : 0;
    row.supporterDamageGivenPerMinute = activeDurationMin > 0 ? row.supporterDamageGiven / activeDurationMin : 0;
    row.supporterPercent = row.supporterDamageGiven > 0 && row.encounterDamageDealt > 0
      ? (row.supporterDamageGiven / row.encounterDamageDealt) * 100
      : 0;
    row.supporterTier = classifySupporterTier(row.supporterPercent);
    Object.assign(row, selectContextPercentiles(row, row.logRole));
  }));
}

function isModernProfileRow(row) {
  return !!row?.hasDamageStats &&
    (Number(row.damageDealt) || 0) > 0 &&
    (Number(row.hits) || 0) > 0 &&
    (Number(row.skillCount) || 0) > 0;
}

function summarizeGroup(rows) {
  const dps = rows.map((r) => r.dps);
  const peak10sDps = rows.map((r) => r.peak10sDps).filter((n) => n > 0);
  const burstRatios = rows.map((r) => r.burstRatio).filter((n) => n > 0);
  const shares = rows.map((r) => r.partyDps > 0 ? (r.dps / r.partyDps) * 100 : 0);
  const ranks = rows.map((r) => r.damageRank).filter((n) => n > 0);
  const protectionPerMinute = rows.map((r) => r.protectionPerMinute);
  const damageRows = rows.filter((r) => r.hasDamageStats);
  const deathCounts = rows.map((r) => Number(r.deathCount) || 0);
  const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const deadTimes = rows.map((r) => Number(r.deadTimeMs) || 0);
  const totalDeadTimeMs = deadTimes.reduce((sum, n) => sum + n, 0);
  const damageTakenShareRows = damageRows.filter((r) => r.damageTakenShareValid);
  const rdpsRows = rows.filter((r) => r.rdpsValid);
  const rdpsValidCount = rdpsRows.length;
  const supporterRows = rdpsRows.length ? rdpsRows : rows;
  const supporterPercents = supporterRows.map((r) => Number(r.supporterPercent) || 0);
  const radiantSupportCount = supporterRows.filter((r) => r.supporterTier === "radiant").length;
  const supporterRankRows = supporterRows.filter((r) => (Number(r.supporterRank) || 0) > 0 && (Number(r.supporterCount) || 0) > 0);
  const supporterCompetitiveRows = supporterRankRows.filter((r) => (Number(r.supporterCount) || 0) > 1);
  const contextRows = rows.filter((r) => (Number(r.contextSampleCount) || 0) >= MIN_CONTEXT_SAMPLE_COUNT && r.contextSource !== "none");
  const dpsContextRows = contextRows.filter((r) => r.logRole !== "support");
  const supportContextRows = contextRows.filter((r) => r.logRole === "support");
  const avgBackAttackRate = round1(average(rows.map((r) => r.backAttackRate)));
  const avgFrontAttackRate = round1(average(rows.map((r) => r.frontAttackRate)));
  const avgBackAttackDamageShare = round1(average(rows.map((r) => r.backAttackDamageShare)));
  const avgFrontAttackDamageShare = round1(average(rows.map((r) => r.frontAttackDamageShare)));
  const arkRows = rows.filter((r) => r.arkPassiveActive !== null);
  return {
    encounters: rows.length,
    firstFightStart: minPositive(rows.map((r) => r.fightStart)),
    lastFightStart: maxPositive(rows.map((r) => r.fightStart)),
    avgDurationMs: Math.round(average(rows.map((r) => r.durationMs))),
    avgActiveDurationMs: Math.round(average(rows.map((r) => r.activeDurationMs))),
    avgIntermissionMs: Math.round(average(rows.map((r) => r.intermissionMs))),
    avgActiveTimeRate: round1(average(rows.map((r) => r.activeTimeRate))),
    avgDps: Math.round(average(dps)),
    medianDps: Math.round(percentile(dps, 50)),
    avgPeak10sDps: Math.round(average(peak10sDps)),
    p90Peak10sDps: Math.round(percentile(peak10sDps, 90)),
    avgBurstRatio: round2(average(burstRatios)),
    avgDamageShare: round1(average(shares)),
    avgTopDamageProximity: round1(average(rows.map((r) => r.topDamageProximity))),
    contextCoverageRate: round1((contextRows.length / rows.length) * 100),
    contextSampleCountAvg: round1(average(contextRows.map((r) => r.contextSampleCount))),
    avgContextPerformancePercentile: round1(average(contextRows.map((r) => r.contextPerformancePercentile))),
    avgContextDamageSharePercentile: round1(average(dpsContextRows.map((r) => r.contextDamageSharePercentile))),
    avgContextTopDamageProximityPercentile: round1(average(dpsContextRows.map((r) => r.contextTopDamageProximityPercentile))),
    avgContextSupportPercentile: round1(average(supportContextRows.map((r) => r.contextSupportPercentile))),
    topRate: round1((rows.filter((r) => r.damageRank === 1).length / rows.length) * 100),
    avgRank: round2(average(ranks)),
    deathlessRate: round1(((rows.length - deathRows) / rows.length) * 100),
    deathRate: round1((deathRows / rows.length) * 100),
    totalDeaths,
    avgDeaths: round2(average(deathCounts)),
    totalDeadTimeMs: Math.round(totalDeadTimeMs),
    avgDeadTimeMs: Math.round(average(deadTimes)),
    avgDeadTimeRate: round1(average(rows.map((r) => r.deadTimeRate))),
    rdpsValidCount,
    rdpsValidRate: round1((rdpsValidCount / rows.length) * 100),
    avgSupporterPercent: round1(average(supporterPercents)),
    medianSupporterPercent: round1(percentile(supporterPercents, 50)),
    radiantSupportCount,
    radiantSupportRate: round1(supporterRows.length ? (radiantSupportCount / supporterRows.length) * 100 : 0),
    avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((r) => r.supporterDamageGivenPerMinute))),
    supporterRankValidCount: supporterRankRows.length,
    supporterCompetitiveCount: supporterCompetitiveRows.length,
    avgSupporterRank: round2(average(supporterRankRows.map((r) => r.supporterRank))),
    supporterCountAvg: round2(average(supporterRankRows.map((r) => r.supporterCount))),
    supporterTopRate: round1(supporterCompetitiveRows.length
      ? (supporterCompetitiveRows.filter((r) => r.supporterRank === 1).length / supporterCompetitiveRows.length) * 100
      : 0),
    avgCritRate: round1(average(rows.map((r) => r.critRate))),
    avgCritDamageShare: round1(average(rows.map((r) => r.critDamageShare))),
    avgBackAttackRate,
    avgFrontAttackRate,
    avgBackAttackDamageShare,
    avgFrontAttackDamageShare,
    avgPositionalDamageShare: round1(average(rows.map((r) => r.positionalDamageShare))),
    attackStyle: classifyAttackStyle(avgBackAttackDamageShare || avgBackAttackRate, avgFrontAttackDamageShare || avgFrontAttackRate),
    avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
    damageTakenShareValidCount: damageTakenShareRows.length,
    avgDamageTakenShare: round1(average(damageTakenShareRows.map((r) => r.damageTakenShare))),
    avgShieldReceivedPerMinute: Math.round(average(damageRows.map((r) => r.shieldReceivedPerMinute))),
    avgStaggerPerMinute: Math.round(average(damageRows.map((r) => r.staggerPerMinute))),
    avgIncapacitations: round2(average(damageRows.map((r) => r.incapacitations))),
    avgIncapacitationsPerMinute: round2(average(damageRows.map((r) => r.incapacitationsPerMinute))),
    avgHyperShare: round1(average(damageRows.map((r) => r.hyperShare))),
    avgUnbuffedDps: Math.round(average(damageRows.map((r) => r.unbuffedDps).filter((n) => n > 0))),
    avgSupportBuffedShare: round1(average(damageRows.map((r) => r.supportBuffedShare))),
    avgSupportDebuffedShare: round1(average(damageRows.map((r) => r.supportDebuffedShare))),
    avgPartyBuffedShare: round1(average(damageRows.map((r) => r.partyBuffedShare))),
    avgSelfBuffedShare: round1(average(damageRows.map((r) => r.selfBuffedShare))),
    avgPartyDebuffedShare: round1(average(damageRows.map((r) => r.partyDebuffedShare))),
    avgBattleItemDebuffedShare: round1(average(damageRows.map((r) => r.battleItemDebuffedShare))),
    avgSynergyGivenPerMinute: Math.round(average(rows.map((r) => r.synergyGivenPerMinute))),
    avgSynergyReceivedShare: round1(average(rows.map((r) => r.synergyReceivedShare))),
    avgSkillCount: round1(average(rows.map((r) => r.skillCount))),
    avgTopSkillShare: round1(average(rows.map((r) => r.topSkillShare))),
    avgProtectionPerMinute: Math.round(average(protectionPerMinute)),
    avgGearScore: round2(average(rows.map((r) => r.gearScore).filter((n) => n > 0))),
    avgCombatPower: round2(average(rows.map((r) => r.combatPower).filter((n) => n > 0))),
    arkPassiveRate: arkRows.length
      ? round1((arkRows.filter((r) => r.arkPassiveActive).length / arkRows.length) * 100)
      : 0,
  };
}

function mergeTopSkills(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    for (const skill of row.topSkills || []) {
      const key = skill.id || normalizeName(skill.name);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: skill.id || "",
          name: skill.name || "Unknown",
          damage: 0,
          casts: 0,
          hits: 0,
          critHits: 0,
          backHits: 0,
          frontHits: 0,
          stagger: 0,
          isHyperAwakening: !!skill.isHyperAwakening,
        });
      }
      const entry = byKey.get(key);
      const hits = Number(skill.hits) || 0;
      entry.damage += Number(skill.damage) || 0;
      entry.casts += Number(skill.casts) || 0;
      entry.hits += hits;
      entry.critHits += hits * ((Number(skill.critRate) || 0) / 100);
      entry.backHits += hits * ((Number(skill.backAttackRate) || 0) / 100);
      entry.frontHits += hits * ((Number(skill.frontAttackRate) || 0) / 100);
      entry.stagger += Number(skill.stagger) || 0;
      entry.isHyperAwakening = entry.isHyperAwakening || !!skill.isHyperAwakening;
    }
  }

  const totalDamage = [...byKey.values()].reduce((sum, skill) => sum + skill.damage, 0);
  return [...byKey.values()]
    .sort((a, b) => b.damage - a.damage || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      damage: Math.round(skill.damage),
      share: totalDamage > 0 ? round1((skill.damage / totalDamage) * 100) : 0,
      casts: Math.round(skill.casts),
      hits: Math.round(skill.hits),
      critRate: skill.hits > 0 ? round1((skill.critHits / skill.hits) * 100) : 0,
      backAttackRate: skill.hits > 0 ? round1((skill.backHits / skill.hits) * 100) : 0,
      frontAttackRate: skill.hits > 0 ? round1((skill.frontHits / skill.hits) * 100) : 0,
      stagger: Math.round(skill.stagger),
      isHyperAwakening: !!skill.isHyperAwakening,
    }));
}

function mergeTopSources(rows, field, denominatorFn, limit = 6) {
  const byKey = new Map();
  let denominator = 0;
  for (const row of rows || []) {
    denominator += Math.max(0, Number(denominatorFn(row)) || 0);
    for (const source of row[field] || []) {
      const key = source.id || `${source.category}\x1f${source.target}\x1f${normalizeName(source.name)}`;
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: source.id || "",
          name: source.name || "Unknown",
          category: source.category || "unknown",
          target: source.target || "UNKNOWN",
          amount: 0,
        });
      }
      byKey.get(key).amount += Number(source.amount) || 0;
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((source) => ({
      id: source.id,
      name: source.name,
      category: source.category,
      target: source.target,
      amount: Math.round(source.amount),
      share: denominator > 0 ? round1((source.amount / denominator) * 100) : 0,
    }));
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function buildProfileSnapshot(rows, rosterAccounts, file, { range = null } = {}) {
  const byChar = new Map();
  for (const row of rows) {
    const key = normalizeName(row.localPlayer);
    if (!byChar.has(key)) byChar.set(key, []);
    byChar.get(key).push(row);
  }

  const accountsByName = new Map();
  for (const [, allCharRows] of byChar) {
    const classRole = roleForProfileClass(allCharRows[0]?.className);
    const supportRows = allCharRows.filter((row) => row.logRole === "support");
    const dpsBuildRows = allCharRows.filter((row) => row.logRole === "dps");
    const role = classRole === "support"
      ? (supportRows.length >= dpsBuildRows.length ? "support" : "dps")
      : classRole;
    const charRows = classRole === "support"
      ? (role === "support" ? supportRows : dpsBuildRows)
      : allCharRows;
    const profileRows = charRows.length ? charRows : allCharRows;
    const sample = profileRows[0];
    const latestRow = profileRows.reduce((best, row) => ((row.fightStart || 0) > (best.fightStart || 0) ? row : best), sample);
    const dps = profileRows.map((r) => r.dps);
    const peak10sDps = profileRows.map((r) => r.peak10sDps).filter((n) => n > 0);
    const burstRatios = profileRows.map((r) => r.burstRatio).filter((n) => n > 0);
    const rdps = profileRows.map((r) => r.rdps);
    const ndps = profileRows.map((r) => r.ndps);
    const shares = profileRows.map((r) => r.damageShare);
    const ranks = profileRows.map((r) => r.damageRank).filter((n) => n > 0);
    const counters = profileRows.map((r) => r.counters);
    const damageRows = profileRows.filter((r) => r.hasDamageStats);
    const protections = profileRows.map((r) => r.protection);
    const protectionPerMinute = profileRows.map((r) => r.protectionPerMinute);
    const deathCounts = profileRows.map((r) => Number(r.deathCount) || 0);
    const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
    const deathRows = deathCounts.filter((n) => n > 0).length;
    const deadTimes = profileRows.map((r) => Number(r.deadTimeMs) || 0);
    const totalDeadTimeMs = deadTimes.reduce((sum, n) => sum + n, 0);
    const damageTakenShareRows = damageRows.filter((r) => r.damageTakenShareValid);
    const rdpsValidRows = profileRows.filter((r) => r.rdpsValid);
    const rdpsValidCount = rdpsValidRows.length;
    const supporterRows = rdpsValidRows.length ? rdpsValidRows : profileRows;
    const supporterPercents = supporterRows.map((r) => Number(r.supporterPercent) || 0);
    const radiantSupportCount = supporterRows.filter((r) => r.supporterTier === "radiant").length;
    const supporterRankRows = supporterRows.filter((r) => (Number(r.supporterRank) || 0) > 0 && (Number(r.supporterCount) || 0) > 0);
    const supporterCompetitiveRows = supporterRankRows.filter((r) => (Number(r.supporterCount) || 0) > 1);
    const contextRows = profileRows.filter((r) => (Number(r.contextSampleCount) || 0) >= MIN_CONTEXT_SAMPLE_COUNT && r.contextSource !== "none");
    const dpsContextRows = contextRows.filter((r) => r.logRole !== "support");
    const supportContextRows = contextRows.filter((r) => r.logRole === "support");
    const avgBackAttackRate = round1(average(profileRows.map((r) => r.backAttackRate)));
    const avgFrontAttackRate = round1(average(profileRows.map((r) => r.frontAttackRate)));
    const avgBackAttackDamageShare = round1(average(profileRows.map((r) => r.backAttackDamageShare)));
    const avgFrontAttackDamageShare = round1(average(profileRows.map((r) => r.frontAttackDamageShare)));
    const topSkills = mergeTopSkills(profileRows);
    const topBuffSources = mergeTopSources(profileRows, "topBuffSources", (r) => r.damageDealt);
    const topDebuffSources = mergeTopSources(profileRows, "topDebuffSources", (r) => r.damageDealt);
    const topShieldGivenSources = mergeTopSources(profileRows, "topShieldGivenSources", (r) => r.protection);
    const topShieldReceivedSources = mergeTopSources(
      profileRows,
      "topShieldReceivedSources",
      (r) => r.shieldsReceived + r.damageAbsorbed
    );
    const arkRows = profileRows.filter((r) => r.arkPassiveActive !== null);
    const buildVariantKeys = new Set(profileRows.map(buildVariantKey).filter(Boolean));
    const buildVariants = summarizeBuildVariants(profileRows);
    const unclassifiedBuildLogCount = countUnclassifiedBuildRows(profileRows);
    const stats = {
      encounters: profileRows.length,
      allEncounterCount: allCharRows.length,
      supportLogCount: supportRows.length,
      dpsBuildLogCount: classRole === "support" ? dpsBuildRows.length : 0,
      supportLogRate: allCharRows.length ? round1((supportRows.length / allCharRows.length) * 100) : 0,
      dpsBuildLogRate: classRole === "support" && allCharRows.length
        ? round1((dpsBuildRows.length / allCharRows.length) * 100)
        : 0,
      primaryRoleRate: allCharRows.length ? round1((profileRows.length / allCharRows.length) * 100) : 0,
      firstFightStart: minPositive(profileRows.map((r) => r.fightStart)),
      lastFightStart: maxPositive(profileRows.map((r) => r.fightStart)),
      avgDurationMs: Math.round(average(profileRows.map((r) => r.durationMs))),
      avgActiveDurationMs: Math.round(average(profileRows.map((r) => r.activeDurationMs))),
      avgIntermissionMs: Math.round(average(profileRows.map((r) => r.intermissionMs))),
      avgActiveTimeRate: round1(average(profileRows.map((r) => r.activeTimeRate))),
      avgDps: Math.round(average(dps)),
      medianDps: Math.round(percentile(dps, 50)),
      p75Dps: Math.round(percentile(dps, 75)),
      p90Dps: Math.round(percentile(dps, 90)),
      avgPeak10sDps: Math.round(average(peak10sDps)),
      p90Peak10sDps: Math.round(percentile(peak10sDps, 90)),
      avgBurstRatio: round2(average(burstRatios)),
      avgRdps: Math.round(average(rdps)),
      medianRdps: Math.round(percentile(rdps, 50)),
      avgNdps: Math.round(average(ndps)),
      medianNdps: Math.round(percentile(ndps, 50)),
      avgDamageShare: round1(average(shares)),
      medianDamageShare: round1(percentile(shares, 50)),
      avgTopDamageProximity: round1(average(profileRows.map((r) => r.topDamageProximity))),
      contextCoverageRate: round1((contextRows.length / profileRows.length) * 100),
      contextSampleCountAvg: round1(average(contextRows.map((r) => r.contextSampleCount))),
      avgContextPerformancePercentile: round1(average(contextRows.map((r) => r.contextPerformancePercentile))),
      avgContextDamageSharePercentile: round1(average(dpsContextRows.map((r) => r.contextDamageSharePercentile))),
      avgContextTopDamageProximityPercentile: round1(average(dpsContextRows.map((r) => r.contextTopDamageProximityPercentile))),
      avgContextSupportPercentile: round1(average(supportContextRows.map((r) => r.contextSupportPercentile))),
      topRate: round1((profileRows.filter((r) => r.damageRank === 1).length / profileRows.length) * 100),
      avgRank: round2(average(ranks)),
      partyCountAvg: round2(average(profileRows.map((r) => r.partyCount).filter((n) => n > 0))),
      deathlessRate: round1(((profileRows.length - deathRows) / profileRows.length) * 100),
      deathRate: round1((deathRows / profileRows.length) * 100),
      totalDeaths,
      avgDeaths: round2(average(deathCounts)),
      totalDeadTimeMs: Math.round(totalDeadTimeMs),
      avgDeadTimeMs: Math.round(average(deadTimes)),
      avgDeadTimeRate: round1(average(profileRows.map((r) => r.deadTimeRate))),
      rdpsValidCount,
      rdpsValidRate: round1((rdpsValidCount / profileRows.length) * 100),
      avgSupporterPercent: round1(average(supporterPercents)),
      medianSupporterPercent: round1(percentile(supporterPercents, 50)),
      radiantSupportCount,
      radiantSupportRate: round1(supporterRows.length ? (radiantSupportCount / supporterRows.length) * 100 : 0),
      avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((r) => r.supporterDamageGivenPerMinute))),
      supporterRankValidCount: supporterRankRows.length,
      supporterCompetitiveCount: supporterCompetitiveRows.length,
      avgSupporterRank: round2(average(supporterRankRows.map((r) => r.supporterRank))),
      supporterCountAvg: round2(average(supporterRankRows.map((r) => r.supporterCount))),
      supporterTopRate: round1(supporterCompetitiveRows.length
        ? (supporterCompetitiveRows.filter((r) => r.supporterRank === 1).length / supporterCompetitiveRows.length) * 100
        : 0),
      avgCounters: round2(average(counters)),
      avgCastsPerMinute: round2(average(profileRows.map((r) => r.castsPerMinute))),
      avgHitsPerMinute: round2(average(profileRows.map((r) => r.hitsPerMinute))),
      avgCritRate: round1(average(profileRows.map((r) => r.critRate))),
      avgCritDamageShare: round1(average(profileRows.map((r) => r.critDamageShare))),
      avgBackAttackRate,
      avgFrontAttackRate,
      avgBackAttackDamageShare,
      avgFrontAttackDamageShare,
      avgPositionalDamageShare: round1(average(profileRows.map((r) => r.positionalDamageShare))),
      attackStyle: classifyAttackStyle(avgBackAttackDamageShare || avgBackAttackRate, avgFrontAttackDamageShare || avgFrontAttackRate),
      avgDamageTaken: Math.round(average(damageRows.map((r) => r.damageTaken))),
      avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
      damageTakenShareValidCount: damageTakenShareRows.length,
      avgDamageTakenShare: round1(average(damageTakenShareRows.map((r) => r.damageTakenShare))),
      avgDamageAbsorbedPerMinute: Math.round(average(damageRows.map((r) => r.damageAbsorbedPerMinute))),
      avgShieldReceivedPerMinute: Math.round(average(damageRows.map((r) => r.shieldReceivedPerMinute))),
      avgStagger: Math.round(average(damageRows.map((r) => r.stagger))),
      avgStaggerPerMinute: Math.round(average(damageRows.map((r) => r.staggerPerMinute))),
      avgIncapacitations: round2(average(damageRows.map((r) => r.incapacitations))),
      avgIncapacitationsPerMinute: round2(average(damageRows.map((r) => r.incapacitationsPerMinute))),
      avgHyperShare: round1(average(damageRows.map((r) => r.hyperShare))),
      avgUnbuffedShare: round1(average(damageRows.map((r) => r.unbuffedShare))),
      avgUnbuffedDps: Math.round(average(damageRows.map((r) => r.unbuffedDps).filter((n) => n > 0))),
      avgSupportBuffedShare: round1(average(damageRows.map((r) => r.supportBuffedShare))),
      avgSupportDebuffedShare: round1(average(damageRows.map((r) => r.supportDebuffedShare))),
      avgPartyBuffedShare: round1(average(damageRows.map((r) => r.partyBuffedShare))),
      avgSelfBuffedShare: round1(average(damageRows.map((r) => r.selfBuffedShare))),
      avgPartyDebuffedShare: round1(average(damageRows.map((r) => r.partyDebuffedShare))),
      avgBattleItemDebuffedShare: round1(average(damageRows.map((r) => r.battleItemDebuffedShare))),
      avgSkillCount: round1(average(profileRows.map((r) => r.skillCount))),
      avgTopSkillShare: round1(average(profileRows.map((r) => r.topSkillShare))),
      avgRdpsDamageGiven: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGiven))),
      avgRdpsDamageGivenPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGivenPerMinute))),
      avgRdpsDamageReceivedSupport: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupport))),
      avgRdpsDamageReceivedSupportPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupportPerMinute))),
      avgSynergyGiven: Math.round(average(profileRows.map((r) => r.synergyGiven))),
      avgSynergyGivenPerMinute: Math.round(average(profileRows.map((r) => r.synergyGivenPerMinute))),
      avgSynergyReceivedShare: round1(average(profileRows.map((r) => r.synergyReceivedShare))),
      avgSupportAp: round2(average(profileRows.map((r) => r.supportAp))),
      avgSupportBrand: round2(average(profileRows.map((r) => r.supportBrand))),
      avgSupportIdentity: round2(average(profileRows.map((r) => r.supportIdentity))),
      avgSupportHyper: round2(average(profileRows.map((r) => r.supportHyper))),
      avgProtection: Math.round(average(protections)),
      avgProtectionPerMinute: Math.round(average(protectionPerMinute)),
      avgGearScore: round2(average(profileRows.map((r) => r.gearScore).filter((n) => n > 0))),
      latestGearScore: round2(latestRow.gearScore),
      avgCombatPower: round2(average(profileRows.map((r) => r.combatPower).filter((n) => n > 0))),
      latestCombatPower: round2(latestRow.combatPower),
      arkPassiveRate: arkRows.length
        ? round1((arkRows.filter((r) => r.arkPassiveActive).length / arkRows.length) * 100)
        : 0,
      buildVariantCount: Math.max(buildVariantKeys.size, buildVariants.length),
      unclassifiedBuildLogCount,
      consistency: computeProfileConsistency(profileRows, role),
    };

    const build = {
      classId: latestRow.classId || 0,
      spec: cleanBuildName(latestRow.arkPassive?.enlightenment?.spec || latestRow.spec),
      gearScore: round2(latestRow.gearScore),
      combatPower: round2(latestRow.combatPower),
      arkPassiveActive: latestRow.arkPassiveActive === null ? null : !!latestRow.arkPassiveActive,
      engravings: latestRow.engravings || [],
      arkPassive: latestRow.arkPassive || null,
    };

    const raidGroups = new Map();
    for (const row of profileRows) {
      const gate = getRaidGateForBoss(row.boss);
      if (!gate) continue;
      const modeKey = normalizeDifficulty(row.difficulty) || "normal";
      const groupKey = `${gate.raidKey}\x1f${modeKey}\x1f${row.boss}`;
      if (!raidGroups.has(groupKey)) raidGroups.set(groupKey, []);
      raidGroups.get(groupKey).push(row);
    }
    const raids = [...raidGroups.values()].map((groupRows) => {
      const gate = getRaidGateForBoss(groupRows[0].boss);
      const modeKey = normalizeDifficulty(groupRows[0].difficulty) || "normal";
      return {
        raidKey: gate?.raidKey || "",
        modeKey,
        boss: groupRows[0].boss,
        ...summarizeGroup(groupRows),
      };
    }).sort((a, b) => (b.lastFightStart || 0) - (a.lastFightStart || 0));

    const accountName = sample.accountName || "";
    if (!accountsByName.has(accountName)) {
      accountsByName.set(accountName, { accountName, characters: [] });
    }
    accountsByName.get(accountName).characters.push({
      name: sample.localPlayer,
      class: sample.className,
      itemLevel: sample.itemLevel,
      classRole,
      role,
      stats,
      scores: computeScores(stats, role),
      build,
      topSkills,
      topBuffSources,
      topDebuffSources,
      topShieldGivenSources,
      topShieldReceivedSources,
      buildVariants,
      raids,
    });
  }

  for (const account of accountsByName.values()) {
    account.characters.sort((a, b) => b.stats.encounters - a.stats.encounters || a.name.localeCompare(b.name));
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    db: {
      fileName: file?.name || "encounters.db",
      size: Number(file?.size) || 0,
      lastModified: Number(file?.lastModified) || null,
    },
    accounts: [...accountsByName.values()].sort((a, b) => a.accountName.localeCompare(b.accountName)),
    criteria: {
      clearedOnly: true,
      supportedBossesOnly: true,
      minDurationMs: MIN_DURATION_MS,
      modernProfileStatsOnly: true,
      range,
    },
  };
}

function compactEncounterArkPassive(arkPassive) {
  const compactTree = (tree = {}) => ({
    count: Number(tree.count) || 0,
    points: Number(tree.points) || 0,
    spentPoints: Number(tree.spentPoints) || 0,
    spec: cleanBuildName(tree.spec),
  });
  if (!arkPassive) return null;
  return {
    evolution: compactTree(arkPassive.evolution),
    enlightenment: compactTree(arkPassive.enlightenment),
    leap: compactTree(arkPassive.leap),
  };
}

function buildProfileEncounterSummaries(rows, file, { range = null } = {}) {
  return (rows || []).slice(0, MAX_PROFILE_ENCOUNTER_SUMMARIES).map((row) => {
    const gate = getRaidGateForBoss(row.boss);
    if (!gate) return null;
    const modeKey = normalizeDifficulty(row.difficulty) || "normal";
    return {
      encounterId: String(row.encounterId || `${row.fightStart}:${row.localPlayer}:${row.boss}`),
      accountName: row.accountName || "",
      characterName: row.localPlayer || "",
      class: row.className || "",
      itemLevel: Number(row.itemLevel) || 0,
      classRole: row.classRole || "unknown",
      role: row.logRole || row.classRole || "unknown",
      fightStart: Number(row.fightStart) || 0,
      durationMs: Math.round(Number(row.durationMs) || 0),
      boss: row.boss || "",
      raidKey: gate.raidKey || "",
      modeKey,
      difficulty: row.difficulty || "",
      rangeType: range?.type === "weekly" ? "weekly" : "full",
      build: {
        classId: Number(row.classId) || 0,
        spec: cleanBuildName(row.arkPassive?.enlightenment?.spec || row.spec),
        gearScore: round2(row.gearScore),
        combatPower: round2(row.combatPower),
        arkPassiveActive: row.arkPassiveActive === null ? null : !!row.arkPassiveActive,
        engravings: (row.engravings || []).slice(0, 4),
        arkPassive: compactEncounterArkPassive(row.arkPassive),
      },
      metrics: {
        dps: Math.round(Number(row.dps) || 0),
        rdps: Math.round(Number(row.rdps) || 0),
        ndps: Math.round(Number(row.ndps) || 0),
        peak10sDps: Math.round(Number(row.peak10sDps) || 0),
        burstRatio: round2(row.burstRatio),
        rdpsValid: row.rdpsValid === true,
        activeDurationMs: Math.round(Number(row.activeDurationMs) || 0),
        intermissionMs: Math.round(Number(row.intermissionMs) || 0),
        activeTimeRate: round1(row.activeTimeRate),
        damageDealt: Math.round(Number(row.damageDealt) || 0),
        damageShare: round1(row.damageShare),
        topDamageProximity: round1(row.topDamageProximity),
        contextSampleCount: Number(row.contextSampleCount) || 0,
        contextSource: row.contextSource || "none",
        contextPerformancePercentile: round1(row.contextPerformancePercentile),
        contextDamageSharePercentile: round1(row.contextDamageSharePercentile),
        contextTopDamageProximityPercentile: round1(row.contextTopDamageProximityPercentile),
        contextSupportPercentile: round1(row.contextSupportPercentile),
        damageRank: Number(row.damageRank) || 0,
        partyCount: Number(row.partyCount) || 0,
        deathCount: Number(row.deathCount) || 0,
        deadTimeMs: Math.round(Number(row.deadTimeMs) || 0),
        deadTimeRate: round1(row.deadTimeRate),
        counters: Number(row.counters) || 0,
        castsPerMinute: round2(row.castsPerMinute),
        hitsPerMinute: round2(row.hitsPerMinute),
        critRate: round1(row.critRate),
        critDamageShare: round1(row.critDamageShare),
        backAttackRate: round1(row.backAttackRate),
        frontAttackRate: round1(row.frontAttackRate),
        backAttackDamageShare: round1(row.backAttackDamageShare),
        frontAttackDamageShare: round1(row.frontAttackDamageShare),
        positionalDamageShare: round1(row.positionalDamageShare),
        topSkillShare: round1(row.topSkillShare),
        damageTakenPerMinute: Math.round(Number(row.damageTakenPerMinute) || 0),
        damageTakenShare: round1(row.damageTakenShare),
        shieldReceivedPerMinute: Math.round(Number(row.shieldReceivedPerMinute) || 0),
        staggerPerMinute: Math.round(Number(row.staggerPerMinute) || 0),
        incapacitations: Number(row.incapacitations) || 0,
        incapacitationsPerMinute: round2(row.incapacitationsPerMinute),
        hyperShare: round1(row.hyperShare),
        unbuffedShare: round1(row.unbuffedShare),
        supportBuffedShare: round1(row.supportBuffedShare),
        supportDebuffedShare: round1(row.supportDebuffedShare),
        partyBuffedShare: round1(row.partyBuffedShare),
        selfBuffedShare: round1(row.selfBuffedShare),
        partyDebuffedShare: round1(row.partyDebuffedShare),
        battleItemDebuffedShare: round1(row.battleItemDebuffedShare),
        protectionPerMinute: Math.round(Number(row.protectionPerMinute) || 0),
        rdpsDamageGivenPerMinute: Math.round(Number(row.rdpsDamageGivenPerMinute) || 0),
        rdpsDamageReceivedSupportPerMinute: Math.round(Number(row.rdpsDamageReceivedSupportPerMinute) || 0),
        supporterDamageGiven: Math.round(Number(row.supporterDamageGiven) || 0),
        supporterDamageGivenPerMinute: Math.round(Number(row.supporterDamageGivenPerMinute) || 0),
        supporterPercent: round1(row.supporterPercent),
        supporterTier: row.supporterTier || "none",
        supporterRank: Number(row.supporterRank) || 0,
        supporterCount: Number(row.supporterCount) || 0,
        synergyGivenPerMinute: Math.round(Number(row.synergyGivenPerMinute) || 0),
        synergyReceivedShare: round1(row.synergyReceivedShare),
      },
      topSkills: (row.topSkills || []).slice(0, 5).map((skill) => ({
        id: String(skill.id || "").slice(0, 32),
        name: cleanBuildName(skill.name),
        damage: Math.round(Number(skill.damage) || 0),
        share: round1(skill.share),
        casts: Math.round(Number(skill.casts) || 0),
        hits: Math.round(Number(skill.hits) || 0),
        critRate: round1(skill.critRate),
        backAttackRate: round1(skill.backAttackRate),
        frontAttackRate: round1(skill.frontAttackRate),
        stagger: Math.round(Number(skill.stagger) || 0),
        isHyperAwakening: !!skill.isHyperAwakening,
      })),
    };
  }).filter(Boolean);
}

function fingerprintSnapshot(snapshot) {
  const parts = [];
  parts.push([
    "range",
    snapshot.criteria?.range?.type || "",
    snapshot.criteria?.range?.minFightStartMs || 0,
  ].join(":"));
  for (const account of snapshot.accounts || []) {
    for (const character of account.characters || []) {
      const stats = character.stats || {};
      const scores = character.scores || {};
      parts.push([
        "char",
        account.accountName,
        character.name,
        character.role || "",
        stats.encounters || 0,
        stats.lastFightStart || 0,
        stats.avgDps || 0,
        stats.medianDps || 0,
        stats.buildVariantCount || 0,
        stats.unclassifiedBuildLogCount || 0,
        stats.avgPeak10sDps || 0,
        stats.p90Peak10sDps || 0,
        stats.avgBurstRatio || 0,
        stats.avgDamageShare || 0,
        stats.avgTopDamageProximity || 0,
        stats.contextCoverageRate || 0,
        stats.contextSampleCountAvg || 0,
        stats.avgContextPerformancePercentile || 0,
        stats.avgContextDamageSharePercentile || 0,
        stats.avgContextTopDamageProximityPercentile || 0,
        stats.avgContextSupportPercentile || 0,
        stats.avgSupporterPercent || 0,
        stats.radiantSupportRate || 0,
        stats.avgSupporterRank || 0,
        stats.supporterCountAvg || 0,
        stats.supporterTopRate || 0,
        stats.avgCritDamageShare || 0,
        stats.avgBackAttackDamageShare || 0,
        stats.avgFrontAttackDamageShare || 0,
        stats.avgPositionalDamageShare || 0,
        stats.avgActiveDurationMs || 0,
        stats.avgIntermissionMs || 0,
        stats.avgActiveTimeRate || 0,
        stats.avgDamageTakenShare || 0,
        stats.damageTakenShareValidCount || 0,
        stats.totalDeaths || 0,
        stats.totalDeadTimeMs || 0,
        scores.overall || 0,
        scores.mvp || 0,
        (character.buildVariants || [])
          .map((variant) => `${variant.name}:${variant.encounters}:${variant.avgDps}:${variant.avgContextPerformancePercentile || 0}`)
          .join(","),
      ].join(":"));
    }
  }
  for (const encounter of snapshot.encounters || []) {
    const metrics = encounter.metrics || {};
    parts.push([
      "enc",
      encounter.encounterId,
      encounter.characterName,
      encounter.fightStart,
      metrics.dps || 0,
      metrics.rdps || 0,
      metrics.ndps || 0,
      metrics.peak10sDps || 0,
      metrics.burstRatio || 0,
      metrics.rdpsValid ? 1 : 0,
      metrics.activeDurationMs || 0,
      metrics.intermissionMs || 0,
      metrics.activeTimeRate || 0,
      metrics.damageDealt || 0,
      metrics.damageShare || 0,
      metrics.topDamageProximity || 0,
      metrics.contextSampleCount || 0,
      metrics.contextSource || "",
      metrics.contextPerformancePercentile || 0,
      metrics.contextDamageSharePercentile || 0,
      metrics.contextTopDamageProximityPercentile || 0,
      metrics.contextSupportPercentile || 0,
      metrics.damageRank || 0,
      metrics.deathCount || 0,
      metrics.deadTimeMs || 0,
      metrics.counters || 0,
      metrics.critRate || 0,
      metrics.critDamageShare || 0,
      metrics.backAttackDamageShare || 0,
      metrics.frontAttackDamageShare || 0,
      metrics.positionalDamageShare || 0,
      metrics.topSkillShare || 0,
      metrics.protectionPerMinute || 0,
      metrics.damageTakenShare || 0,
      metrics.rdpsDamageGivenPerMinute || 0,
      metrics.supporterDamageGiven || 0,
      metrics.supporterPercent || 0,
      metrics.supporterTier || "",
      metrics.supporterRank || 0,
      metrics.supporterCount || 0,
      (encounter.topSkills || [])
        .slice(0, 5)
        .map((skill) => `${skill.id || skill.name || ""}:${skill.damage || 0}:${skill.share || 0}`)
        .join(","),
    ].join(":"));
  }
  return parts.sort().join("|");
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
    renderStatus?.("info", reason === "initial" ? t("profileSync.scanning") : t("profileSync.checking"));
    const rows = await queryProfileRows(file, rosterAccounts, { minFightStartMs });
    const weeklyReason = reason === "weekly";
    if (rows.length === 0) {
      renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklyIdle" : "profileSync.idle", { n: 0 }));
      return { ok: true, sent: false, rows: 0 };
    }
    const snapshot = buildProfileSnapshot(rows, rosterAccounts, file, {
      range: minFightStartMs > 0
        ? { type: "weekly", minFightStartMs: Number(minFightStartMs) || 0 }
        : { type: "full" },
    });
    snapshot.encounters = buildProfileEncounterSummaries(rows, file, {
      range: snapshot.criteria?.range,
    });
    const fp = `${discordId}\x1f${fingerprintSnapshot(snapshot)}`;
    if (!fp || fp === lastProfileFingerprint) {
      renderStatus?.("ok", t(weeklyReason ? "profileSync.weeklyIdle" : "profileSync.idle", { n: rows.length }));
      return { ok: true, sent: false, rows: rows.length };
    }
    const session = await ensureProfileSession({
      discordId,
      localToken: getLocalToken?.(),
      renderStatus,
    });
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
