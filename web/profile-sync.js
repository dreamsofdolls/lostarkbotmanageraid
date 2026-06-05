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

const WA_SQLITE_VERSION = "1.3.0";
const WA_SQLITE_BASE = `https://cdn.jsdelivr.net/npm/@journeyapps/wa-sqlite@${WA_SQLITE_VERSION}`;
const PROFILE_SESSION_STORAGE_KEY = "artist-profile-sync-session";
const PROFILE_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_DURATION_MS = 180000;
const SUPPORT_CLASSES = new Set(["bard", "paladin", "artist", "valkyrie", "holyknight"]);
const SUPPORT_PROTECTION_P90_PER_MIN = 10000000;
const SUPPORT_LOG_UPTIME_THRESHOLD = 25;
const SUPPORT_LOG_PROTECTION_PER_MIN_THRESHOLD = 500000;
const SUPPORT_LOG_RDPS_GIVEN_PER_MIN_THRESHOLD = 500000;
const STAGGER_P90_PER_MIN = 3500;
const POSITIONAL_ATTACK_RATE_THRESHOLD = 45;

let profileSyncTimer = null;
let profileSyncInFlight = false;
let lastProfileFingerprint = "";

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function roleForClass(className) {
  const key = normalizeName(className).replace(/\s+/g, "");
  if (SUPPORT_CLASSES.has(key)) return "support";
  return className ? "dps" : "unknown";
}

function sqlString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
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

    const eCol = (name) => `e.${quoteIdent(name)}`;
    const classExpr = entityCols.has("class") ? `COALESCE(${eCol("class")}, '')` : "''";
    const rdpsExpr = entityCols.has("rdps") ? `COALESCE(${eCol("rdps")}, 0)` : "0";
    const ndpsExpr = entityCols.has("ndps") ? `COALESCE(${eCol("ndps")}, 0)` : "0";
    const isDeadExpr = entityCols.has("is_dead") ? `COALESCE(${eCol("is_dead")}, 0)` : "0";
    const supportApExpr = entityCols.has("support_ap") ? `COALESCE(${eCol("support_ap")}, 0)` : "0";
    const supportBrandExpr = entityCols.has("support_brand") ? `COALESCE(${eCol("support_brand")}, 0)` : "0";
    const supportIdentityExpr = entityCols.has("support_identity") ? `COALESCE(${eCol("support_identity")}, 0)` : "0";
    const supportHyperExpr = entityCols.has("support_hyper") ? `COALESCE(${eCol("support_hyper")}, 0)` : "0";
    const skillStatsExpr = entityCols.has("skill_stats") ? `COALESCE(${eCol("skill_stats")}, '')` : "''";
    const rdpsDamageGivenExpr = entityCols.has("rdps_damage_given") ? `COALESCE(${eCol("rdps_damage_given")}, 0)` : "0";
    const rdpsDamageReceivedExpr = entityCols.has("rdps_damage_received") ? `COALESCE(${eCol("rdps_damage_received")}, 0)` : "0";
    const rdpsDamageReceivedSupportExpr = entityCols.has("rdps_damage_received_support") ? `COALESCE(${eCol("rdps_damage_received_support")}, 0)` : "0";
    const damageStatsExpr = entityCols.has("damage_stats") ? eCol("damage_stats") : "NULL";
    const skillsExpr = entityCols.has("skills") ? eCol("skills") : "NULL";
    const classIdExpr = entityCols.has("class_id") ? eCol("class_id") : "NULL";
    const gearScoreExpr = entityCols.has("gear_score") ? eCol("gear_score") : "NULL";
    const combatPowerExpr = entityCols.has("combat_power") ? eCol("combat_power") : "NULL";
    const arkPassiveActiveExpr = entityCols.has("ark_passive_active") ? eCol("ark_passive_active") : "NULL";
    const engravingsExpr = entityCols.has("engravings") ? eCol("engravings") : "NULL";
    const specExpr = entityCols.has("spec") ? eCol("spec") : "NULL";
    const arkPassiveDataExpr = entityCols.has("ark_passive_data") ? eCol("ark_passive_data") : "NULL";
    const gearHashExpr = entityCols.has("gear_hash") ? eCol("gear_hash") : "NULL";
    const loadoutHashExpr = entityCols.has("loadout_hash") ? eCol("loadout_hash") : "NULL";
    const entityUnbuffedDamageExpr = entityCols.has("unbuffed_damage") ? `COALESCE(${eCol("unbuffed_damage")}, 0)` : "0";
    const entityUnbuffedDpsExpr = entityCols.has("unbuffed_dps") ? `COALESCE(${eCol("unbuffed_dps")}, 0)` : "0";

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
               ${encounterShieldBuffsExpr} AS encounter_shield_buffs
        FROM encounter_preview ep
        ${encounterJoin}
        WHERE ${clearedSql} = 1
          AND ${durationMsExpr} > ${MIN_DURATION_MS}
          ${minFightStartFilter}
          AND ${bossSql} IN (${supportedBosses})
          AND ${charSql} IS NOT NULL
          AND ${charSql} != ''
      ),
      ranked AS (
        SELECT ${eCol("encounter_id")} AS encounter_id,
               ${eCol("name")} AS name,
               ${classExpr} AS class_name,
               COALESCE(${eCol("dps")}, 0) AS dps,
               ${rdpsExpr} AS rdps,
               ${ndpsExpr} AS ndps,
               ${isDeadExpr} AS is_dead,
               ${supportApExpr} AS support_ap,
               ${supportBrandExpr} AS support_brand,
               ${supportIdentityExpr} AS support_identity,
               ${supportHyperExpr} AS support_hyper,
               ${skillStatsExpr} AS skill_stats,
               ${rdpsDamageGivenExpr} AS rdps_damage_given,
               ${rdpsDamageReceivedExpr} AS rdps_damage_received,
               ${rdpsDamageReceivedSupportExpr} AS rdps_damage_received_support,
                ${damageStatsExpr} AS damage_stats,
                ${skillsExpr} AS skills,
                SUM(COALESCE(${eCol("dps")}, 0)) OVER (PARTITION BY ${eCol("encounter_id")}) AS party_dps,
                RANK() OVER (PARTITION BY ${eCol("encounter_id")} ORDER BY COALESCE(${eCol("dps")}, 0) DESC) AS damage_rank,
                COUNT(*) OVER (PARTITION BY ${eCol("encounter_id")}) AS party_count,
                ${classIdExpr} AS class_id,
                ${gearScoreExpr} AS gear_score,
                ${combatPowerExpr} AS combat_power,
                ${arkPassiveActiveExpr} AS ark_passive_active,
                ${engravingsExpr} AS engravings,
                ${specExpr} AS spec,
                ${arkPassiveDataExpr} AS ark_passive_data,
                ${gearHashExpr} AS gear_hash,
                ${loadoutHashExpr} AS loadout_hash,
                ${entityUnbuffedDamageExpr} AS entity_unbuffed_damage,
                ${entityUnbuffedDpsExpr} AS entity_unbuffed_dps
         FROM entity e
         JOIN eligible ep ON ep.id = ${eCol("encounter_id")}
         WHERE ${eCol("entity_type")} = 'PLAYER'
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
             r.class_name,
             r.dps,
             r.rdps,
             r.ndps,
             r.is_dead,
             r.support_ap,
             r.support_brand,
             r.support_identity,
             r.support_hyper,
             r.skill_stats,
             r.rdps_damage_given,
             r.rdps_damage_received,
             r.rdps_damage_received_support,
             r.damage_stats,
              r.skills,
              r.party_dps,
              r.damage_rank,
              r.party_count,
              r.class_id,
              r.gear_score,
              r.combat_power,
              r.ark_passive_active,
              r.engravings,
              r.spec,
              r.ark_passive_data,
              r.gear_hash,
              r.loadout_hash,
              r.entity_unbuffed_damage,
              r.entity_unbuffed_dps
      FROM eligible ep
      JOIN ranked r ON r.encounter_id = ep.id AND r.name = ep.local_player
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
        classId: Number(row[29]) || 0,
        gearScore: Number(row[30]) || 0,
        combatPower: Number(row[31]) || 0,
        arkPassiveActive: row[32] === null || row[32] === undefined ? null : Number(row[32]) ? 1 : 0,
        engravingsRaw: row[33] || "",
        spec: row[34] || "",
        arkPassiveDataRaw: row[35] || "",
        gearHash: row[36] || "",
        loadoutHash: row[37] || "",
        entityUnbuffedDamage: Number(row[38]) || 0,
        entityUnbuffedDps: Number(row[39]) || 0,
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

function stddev(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length <= 1) return 0;
  const avg = average(nums);
  const variance = average(nums.map((n) => (n - avg) ** 2));
  return Math.sqrt(variance);
}

function minPositive(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : 0;
}

function maxPositive(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : 0;
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
  if (row.loadoutHash) return `loadout:${row.loadoutHash}`;
  if (row.gearHash) return `gear:${row.gearHash}`;
  const engravingKey = (row.engravings || []).map((entry) => `${entry.id}:${entry.level}`).join(",");
  const specKey = normalizeName(row.spec);
  if (!engravingKey && !specKey) return "";
  return `${specKey}\x1f${engravingKey}\x1f${row.arkPassiveActive ?? ""}`;
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

function normalizeRate(value) {
  const n = Number(value) || 0;
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
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
    const durationMin = row.durationMs > 0 ? row.durationMs / 60000 : 0;
    const deathInfoCount = Array.isArray(stats?.deathInfo) ? stats.deathInfo.length : 0;
    const parsedDeaths = Number(stats?.deaths) || 0;
    row.deathCount = Math.max(parsedDeaths, deathInfoCount, row.isDead ? 1 : 0);
    row.isDead = row.deathCount > 0 ? 1 : row.isDead;
    row.counters = skill.counters;
    row.casts = skill.casts;
    row.hits = skill.hits;
    row.critRate = skill.critRate;
    row.backAttackRate = skill.backAttackRate;
    row.frontAttackRate = skill.frontAttackRate;
    row.castsPerMinute = durationMin > 0 ? skill.casts / durationMin : 0;
    row.hitsPerMinute = durationMin > 0 ? skill.hits / durationMin : 0;
    row.attackStyle = classifyAttackStyle(row.backAttackRate, row.frontAttackRate);
    row.damageDealt = Number(stats?.damageDealt) || Math.round(row.dps * durationMin * 60) || 0;
    const skillBreakdown = parseSkillBreakdown(skills, row.damageDealt);
    row.skillCount = skillBreakdown.skillCount;
    row.topSkillShare = skillBreakdown.topSkillShare;
    row.topSkills = skillBreakdown.topSkills;
    row.damageTaken = Number(stats?.damageTaken) || 0;
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
    row.damageTakenPerMinute = durationMin > 0 ? row.damageTaken / durationMin : 0;
    row.damageAbsorbedPerMinute = durationMin > 0 ? row.damageAbsorbed / durationMin : 0;
    row.shieldReceivedPerMinute = durationMin > 0 ? row.shieldsReceived / durationMin : 0;
    row.staggerPerMinute = durationMin > 0 ? row.stagger / durationMin : 0;
    row.incapacitationsPerMinute = durationMin > 0 ? row.incapacitations / durationMin : 0;
    row.hyperShare = row.damageDealt > 0 ? (row.hyperAwakeningDamage / row.damageDealt) * 100 : 0;
    row.unbuffedShare = row.damageDealt > 0 ? (row.unbuffedDamage / row.damageDealt) * 100 : 0;
    row.supportBuffedShare = row.damageDealt > 0 ? (row.buffedBySupport / row.damageDealt) * 100 : 0;
    row.supportDebuffedShare = row.damageDealt > 0 ? (row.debuffedBySupport / row.damageDealt) * 100 : 0;
    const shieldsGiven = Number(stats?.shieldsGiven) || 0;
    const absorbedOnOthers = Number(stats?.damageAbsorbedOnOthers) || 0;
    row.shieldsGiven = shieldsGiven;
    row.damageAbsorbedOnOthers = absorbedOnOthers;
    row.protection = shieldsGiven + absorbedOnOthers;
    row.protectionPerMinute = durationMin > 0 ? row.protection / durationMin : 0;
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
    row.rdpsDamageGivenPerMinute = durationMin > 0 ? row.rdpsDamageGiven / durationMin : 0;
    row.rdpsDamageReceivedSupportPerMinute = durationMin > 0 ? row.rdpsDamageReceivedSupport / durationMin : 0;
    const contribution = extractContributionMetrics(misc, row.localPlayer, row.damageDealt);
    row.partyNumber = Number.isFinite(contribution.partyNumber) ? contribution.partyNumber : null;
    row.synergyGiven = contribution.synergyGiven;
    row.synergyReceived = contribution.synergyReceived;
    row.synergyGivenPerMinute = durationMin > 0 ? contribution.synergyGiven / durationMin : 0;
    row.synergyReceivedShare = contribution.synergyReceivedShare;
    row.damageShare = row.partyDps > 0 ? (row.dps / row.partyDps) * 100 : 0;
    row.classRole = roleForClass(row.className);
    row.logRole = classifyLogRole(row);
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
  const shares = rows.map((r) => r.partyDps > 0 ? (r.dps / r.partyDps) * 100 : 0);
  const ranks = rows.map((r) => r.damageRank).filter((n) => n > 0);
  const protections = rows.map((r) => r.protectionPerMinute).filter((n) => n > 0);
  const damageRows = rows.filter((r) => r.hasDamageStats);
  const deathCounts = rows.map((r) => Number(r.deathCount) || 0);
  const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const avgBackAttackRate = round1(average(rows.map((r) => r.backAttackRate)));
  const avgFrontAttackRate = round1(average(rows.map((r) => r.frontAttackRate)));
  const arkRows = rows.filter((r) => r.arkPassiveActive !== null);
  return {
    encounters: rows.length,
    firstFightStart: minPositive(rows.map((r) => r.fightStart)),
    lastFightStart: maxPositive(rows.map((r) => r.fightStart)),
    avgDps: Math.round(average(dps)),
    medianDps: Math.round(percentile(dps, 50)),
    avgDamageShare: round1(average(shares)),
    topRate: round1((rows.filter((r) => r.damageRank === 1).length / rows.length) * 100),
    avgRank: round2(average(ranks)),
    deathlessRate: round1(((rows.length - deathRows) / rows.length) * 100),
    deathRate: round1((deathRows / rows.length) * 100),
    totalDeaths,
    avgDeaths: round2(average(deathCounts)),
    avgCritRate: round1(average(rows.map((r) => r.critRate))),
    avgBackAttackRate,
    avgFrontAttackRate,
    attackStyle: classifyAttackStyle(avgBackAttackRate, avgFrontAttackRate),
    avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
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
    avgProtectionPerMinute: Math.round(average(protections)),
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

function supportUptimeScoreFromStats(stats) {
  const supportAp = normalizeRate(stats.avgSupportAp);
  const supportBrand = normalizeRate(stats.avgSupportBrand);
  const supportIdentity = normalizeRate(stats.avgSupportIdentity);
  const supportHyper = normalizeRate(stats.avgSupportHyper);
  return clampScore(
    (supportAp * 0.3 +
      supportBrand * 0.3 +
      supportIdentity * 0.25 +
      supportHyper * 0.15) * 100
  );
}

function supportUptimeScoreFromRow(row) {
  return supportUptimeScoreFromStats({
    avgSupportAp: row.supportAp,
    avgSupportBrand: row.supportBrand,
    avgSupportIdentity: row.supportIdentity,
    avgSupportHyper: row.supportHyper,
  });
}

function classifyLogRole(row) {
  if (row.classRole !== "support") return row.classRole || "unknown";
  const supportUptime = supportUptimeScoreFromRow(row);
  const hasSupportEvidence =
    supportUptime >= SUPPORT_LOG_UPTIME_THRESHOLD ||
    (Number(row.protectionPerMinute) || 0) >= SUPPORT_LOG_PROTECTION_PER_MIN_THRESHOLD ||
    (Number(row.rdpsDamageGivenPerMinute) || 0) >= SUPPORT_LOG_RDPS_GIVEN_PER_MIN_THRESHOLD;
  return hasSupportEvidence ? "support" : "dps";
}

function computeScores(stats, role) {
  const expectedShare = stats.partyCountAvg > 0 ? 100 / stats.partyCountAvg : 20;
  const damageShareScore = clampScore((stats.avgDamageShare / Math.max(1, expectedShare)) * 70);
  const rankScore = stats.partyCountAvg > 1
    ? clampScore(100 - ((stats.avgRank - 1) / (stats.partyCountAvg - 1)) * 100)
    : 50;
  const outputScore = clampScore(damageShareScore * 0.65 + rankScore * 0.35);
  const consistencyScore = clampScore(stats.consistency);
  const survivalScore = computeSurvivalScore(stats);
  const mechanicsScore = computeMechanicsScore(stats);

  if (role === "support") {
    const uptimeScore = supportUptimeScoreFromStats(stats);
    const raidContribution = clampScore((stats.avgRdps / Math.max(1, (stats.avgRdps || 0) + (stats.avgDps || 0))) * 100);
    const protectionScore = stats.avgProtectionPerMinute > 0
      ? clampScore((stats.avgProtectionPerMinute / SUPPORT_PROTECTION_P90_PER_MIN) * 100)
      : 50;
    const overall = clampScore(
      raidContribution * 0.3 +
      uptimeScore * 0.25 +
      protectionScore * 0.15 +
      consistencyScore * 0.1 +
      mechanicsScore * 0.1 +
      survivalScore * 0.1
    );
    const mvp = clampScore(
      raidContribution * 0.3 +
      uptimeScore * 0.25 +
      protectionScore * 0.15 +
      mechanicsScore * 0.1 +
      consistencyScore * 0.1 +
      survivalScore * 0.1
    );
    return {
      overall: round1(overall),
      mvp: round1(mvp),
      raidContribution: round1(raidContribution),
      supportUptime: round1(uptimeScore),
      protection: round1(protectionScore),
      consistency: round1(consistencyScore),
      survival: round1(survivalScore),
      mechanics: round1(mechanicsScore),
    };
  }

  const mvp = clampScore(
    damageShareScore * 0.35 +
    (stats.topRate || 0) * 0.25 +
    outputScore * 0.15 +
    consistencyScore * 0.1 +
    survivalScore * 0.1 +
    mechanicsScore * 0.05
  );
  const overall = clampScore(
    outputScore * 0.35 +
    damageShareScore * 0.2 +
    (rankScore * 0.6 + (stats.topRate || 0) * 0.4) * 0.15 +
    consistencyScore * 0.15 +
    survivalScore * 0.1 +
    mechanicsScore * 0.05
  );
  return {
    overall: round1(overall),
    mvp: round1(mvp),
    output: round1(outputScore),
    damageShare: round1(damageShareScore),
    rank: round1(rankScore),
    consistency: round1(consistencyScore),
    survival: round1(survivalScore),
    mechanics: round1(mechanicsScore),
  };
}

function computeSurvivalScore(stats) {
  const deathlessRate = Number(stats.deathlessRate);
  const derivedDeathRate = Number.isFinite(deathlessRate) ? 100 - deathlessRate : 0;
  const deathRate = Number.isFinite(Number(stats.deathRate)) ? Number(stats.deathRate) : derivedDeathRate;
  const avgDeaths = Number(stats.avgDeaths) || 0;
  return clampScore(100 - deathRate * 1.1 - avgDeaths * 15);
}

function computeMechanicsScore(stats) {
  const counterScore = stats.avgCounters > 0 ? clampScore(stats.avgCounters * 25) : 50;
  const staggerScore = stats.avgStaggerPerMinute > 0
    ? clampScore((stats.avgStaggerPerMinute / STAGGER_P90_PER_MIN) * 100)
    : 50;
  const controlScore = clampScore(100 - (Number(stats.avgIncapacitationsPerMinute) || 0) * 40);
  return clampScore(counterScore * 0.35 + staggerScore * 0.35 + controlScore * 0.3);
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
    const classRole = roleForClass(allCharRows[0]?.className);
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
    const rdps = profileRows.map((r) => r.rdps);
    const ndps = profileRows.map((r) => r.ndps);
    const shares = profileRows.map((r) => r.damageShare);
    const ranks = profileRows.map((r) => r.damageRank).filter((n) => n > 0);
    const counters = profileRows.map((r) => r.counters);
    const damageRows = profileRows.filter((r) => r.hasDamageStats);
    const protections = profileRows.map((r) => r.protection).filter((n) => n > 0);
    const protectionPerMinute = profileRows.map((r) => r.protectionPerMinute).filter((n) => n > 0);
    const deathCounts = profileRows.map((r) => Number(r.deathCount) || 0);
    const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
    const deathRows = deathCounts.filter((n) => n > 0).length;
    const avgBackAttackRate = round1(average(profileRows.map((r) => r.backAttackRate)));
    const avgFrontAttackRate = round1(average(profileRows.map((r) => r.frontAttackRate)));
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
    const coeff = average(dps) > 0 ? stddev(dps) / average(dps) : 1;
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
      avgDps: Math.round(average(dps)),
      medianDps: Math.round(percentile(dps, 50)),
      p75Dps: Math.round(percentile(dps, 75)),
      p90Dps: Math.round(percentile(dps, 90)),
      avgRdps: Math.round(average(rdps)),
      medianRdps: Math.round(percentile(rdps, 50)),
      avgNdps: Math.round(average(ndps)),
      medianNdps: Math.round(percentile(ndps, 50)),
      avgDamageShare: round1(average(shares)),
      medianDamageShare: round1(percentile(shares, 50)),
      topRate: round1((profileRows.filter((r) => r.damageRank === 1).length / profileRows.length) * 100),
      avgRank: round2(average(ranks)),
      partyCountAvg: round2(average(profileRows.map((r) => r.partyCount).filter((n) => n > 0))),
      deathlessRate: round1(((profileRows.length - deathRows) / profileRows.length) * 100),
      deathRate: round1((deathRows / profileRows.length) * 100),
      totalDeaths,
      avgDeaths: round2(average(deathCounts)),
      avgCounters: round2(average(counters)),
      avgCastsPerMinute: round2(average(profileRows.map((r) => r.castsPerMinute))),
      avgHitsPerMinute: round2(average(profileRows.map((r) => r.hitsPerMinute))),
      avgCritRate: round1(average(profileRows.map((r) => r.critRate))),
      avgBackAttackRate,
      avgFrontAttackRate,
      attackStyle: classifyAttackStyle(avgBackAttackRate, avgFrontAttackRate),
      avgDamageTaken: Math.round(average(damageRows.map((r) => r.damageTaken))),
      avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
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
      avgRdpsDamageGiven: Math.round(average(profileRows.map((r) => r.rdpsDamageGiven).filter((n) => n > 0))),
      avgRdpsDamageGivenPerMinute: Math.round(average(profileRows.map((r) => r.rdpsDamageGivenPerMinute).filter((n) => n > 0))),
      avgRdpsDamageReceivedSupport: Math.round(average(profileRows.map((r) => r.rdpsDamageReceivedSupport).filter((n) => n > 0))),
      avgRdpsDamageReceivedSupportPerMinute: Math.round(average(profileRows.map((r) => r.rdpsDamageReceivedSupportPerMinute).filter((n) => n > 0))),
      avgSynergyGiven: Math.round(average(profileRows.map((r) => r.synergyGiven).filter((n) => n > 0))),
      avgSynergyGivenPerMinute: Math.round(average(profileRows.map((r) => r.synergyGivenPerMinute).filter((n) => n > 0))),
      avgSynergyReceivedShare: round1(average(profileRows.map((r) => r.synergyReceivedShare).filter((n) => n > 0))),
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
      buildVariantCount: buildVariantKeys.size,
      consistency: round1(clampScore(100 - coeff * 100)),
    };

    const build = {
      classId: latestRow.classId || 0,
      spec: cleanBuildName(latestRow.spec || latestRow.arkPassive?.enlightenment?.spec),
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

function fingerprintSnapshot(snapshot) {
  const parts = [];
  for (const account of snapshot.accounts || []) {
    for (const character of account.characters || []) {
      parts.push([
        account.accountName,
        character.name,
        character.stats?.encounters || 0,
        character.stats?.lastFightStart || 0,
      ].join(":"));
    }
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
    const snapshot = buildProfileSnapshot(rows, rosterAccounts, file, {
      range: minFightStartMs > 0
        ? { type: "weekly", minFightStartMs: Number(minFightStartMs) || 0 }
        : { type: "full" },
    });
    const fp = fingerprintSnapshot(snapshot);
    const weeklyReason = reason === "weekly";
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
