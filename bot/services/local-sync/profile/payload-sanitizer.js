"use strict";

const {
  CHARACTER_PROFILE_STATS_KEYS,
  CHARACTER_PROFILE_STATS_CLAMP_RULES,
  CHARACTER_PROFILE_SCORE_KEYS,
} = require("./sanitize-rules");

const PROFILE_VERSION = 1;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_ACCOUNTS = 25;
const MAX_CHARACTERS_PER_ACCOUNT = 25;
const MAX_RAID_BREAKDOWNS_PER_CHAR = 40;
const MAX_TOP_SKILLS_PER_CHAR = 8;
const MAX_TOP_SOURCES_PER_CHAR = 8;
const MAX_BUILD_VARIANTS_PER_CHAR = 8;
const MAX_ENGRAVINGS_PER_CHAR = 8;
const MAX_ARK_PASSIVE_NODES_PER_TREE = 40;
const MAX_ENCOUNTER_SUMMARIES_PER_SYNC = 5000;
const MAX_TOP_SKILLS_PER_ENCOUNTER = 5;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function clampNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanShortString(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function cleanNumberObject(raw, allowedKeys, opts = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of allowedKeys) {
    if (!(key in raw)) continue;
    out[key] = clampNumber(raw[key], opts);
  }
  return out;
}

function cleanLimitedList(raw, max, cleanItem) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, max)
    .map(cleanItem)
    .filter(Boolean);
}

function clampObjectKeys(target, keys, opts = {}) {
  if (!target || typeof target !== "object") return target;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (key in target) target[key] = clampNumber(target[key], opts);
  }
  return target;
}

function applyClampRules(target, rules) {
  for (const [keys, opts] of rules) clampObjectKeys(target, keys, opts);
  return target;
}

function roleForClass(className, fallback = "unknown") {
  const key = normalizeKey(className).replace(/\s+/g, "");
  if (key === "bard" || key === "paladin" || key === "artist" || key === "valkyrie" || key === "holyknight") {
    return "support";
  }
  if (className) return "dps";
  return fallback === "support" || fallback === "dps" ? fallback : "unknown";
}

function cleanRole(value, fallback = "unknown") {
  if (value === "support" || value === "dps") return value;
  return fallback === "support" || fallback === "dps" ? fallback : "unknown";
}

function cleanAttackStyle(value) {
  return value === "back" || value === "front" || value === "hit_master" ? value : "hit_master";
}

function cleanSupporterTier(value) {
  return value === "radiant" || value === "noble" || value === "supporter" ? value : "none";
}

function buildRosterIndexes(userDoc) {
  const byAccountChar = new Map();
  const byChar = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = account?.accountName || "";
    for (const character of account?.characters || []) {
      const charName = character?.name || character?.charName || "";
      const charKey = normalizeKey(charName);
      if (!charKey) continue;
      const entry = { account, accountName, character, charName };
      byAccountChar.set(`${normalizeKey(accountName)}\x1f${charKey}`, entry);
      if (!byChar.has(charKey)) byChar.set(charKey, entry);
    }
  }
  return { byAccountChar, byChar };
}

function resolveRosterCharacter(indexes, accountName, charName) {
  const accountCharKey = `${normalizeKey(accountName)}\x1f${normalizeKey(charName)}`;
  return indexes.byAccountChar.get(accountCharKey) || indexes.byChar.get(normalizeKey(charName)) || null;
}

function cleanRaidBreakdown(raw) {
  if (!raw || typeof raw !== "object") return null;
  const raidKey = cleanShortString(raw.raidKey, 32);
  const modeKey = cleanShortString(raw.modeKey, 32);
  if (!raidKey || !modeKey) return null;
  return {
    raidKey,
    modeKey,
    boss: cleanShortString(raw.boss, 120),
    encounters: clampNumber(raw.encounters, { max: 100000 }),
    firstFightStart: clampNumber(raw.firstFightStart, { max: 9999999999999, fallback: null }),
    lastFightStart: clampNumber(raw.lastFightStart, { max: 9999999999999, fallback: null }),
    avgDurationMs: clampNumber(raw.avgDurationMs, { max: 24 * 60 * 60 * 1000 }),
    avgActiveDurationMs: clampNumber(raw.avgActiveDurationMs, { max: 24 * 60 * 60 * 1000 }),
    avgIntermissionMs: clampNumber(raw.avgIntermissionMs, { max: 24 * 60 * 60 * 1000 }),
    avgActiveTimeRate: clampNumber(raw.avgActiveTimeRate, { max: 100 }),
    avgDps: clampNumber(raw.avgDps),
    medianDps: clampNumber(raw.medianDps),
    avgPeak10sDps: clampNumber(raw.avgPeak10sDps),
    p90Peak10sDps: clampNumber(raw.p90Peak10sDps),
    avgBurstRatio: clampNumber(raw.avgBurstRatio, { max: 100 }),
    avgDamageShare: clampNumber(raw.avgDamageShare, { max: 100 }),
    avgTopDamageProximity: clampNumber(raw.avgTopDamageProximity, { max: 100 }),
    contextCoverageRate: clampNumber(raw.contextCoverageRate, { max: 100 }),
    contextSampleCountAvg: clampNumber(raw.contextSampleCountAvg, { max: 100000 }),
    avgContextPerformancePercentile: clampNumber(raw.avgContextPerformancePercentile, { max: 100 }),
    avgContextDamageSharePercentile: clampNumber(raw.avgContextDamageSharePercentile, { max: 100 }),
    avgContextTopDamageProximityPercentile: clampNumber(raw.avgContextTopDamageProximityPercentile, { max: 100 }),
    avgContextSupportPercentile: clampNumber(raw.avgContextSupportPercentile, { max: 100 }),
    topRate: clampNumber(raw.topRate, { max: 100 }),
    deathlessRate: clampNumber(raw.deathlessRate, { max: 100 }),
    deathRate: clampNumber(raw.deathRate, { max: 100 }),
    totalDeaths: clampNumber(raw.totalDeaths, { max: 100000 }),
    avgDeaths: clampNumber(raw.avgDeaths, { max: 1000 }),
    totalDeadTimeMs: clampNumber(raw.totalDeadTimeMs, { max: 9999999999999 }),
    avgDeadTimeMs: clampNumber(raw.avgDeadTimeMs, { max: 9999999999999 }),
    avgDeadTimeRate: clampNumber(raw.avgDeadTimeRate, { max: 100 }),
    rdpsValidCount: clampNumber(raw.rdpsValidCount, { max: 100000 }),
    rdpsValidRate: clampNumber(raw.rdpsValidRate, { max: 100 }),
    avgSupporterPercent: clampNumber(raw.avgSupporterPercent, { max: 100 }),
    medianSupporterPercent: clampNumber(raw.medianSupporterPercent, { max: 100 }),
    radiantSupportCount: clampNumber(raw.radiantSupportCount, { max: 100000 }),
    radiantSupportRate: clampNumber(raw.radiantSupportRate, { max: 100 }),
    avgSupporterDamageGivenPerMinute: clampNumber(raw.avgSupporterDamageGivenPerMinute),
    supporterRankValidCount: clampNumber(raw.supporterRankValidCount, { max: 100000 }),
    supporterCompetitiveCount: clampNumber(raw.supporterCompetitiveCount, { max: 100000 }),
    avgSupporterRank: clampNumber(raw.avgSupporterRank, { max: 1000 }),
    supporterCountAvg: clampNumber(raw.supporterCountAvg, { max: 1000 }),
    supporterTopRate: clampNumber(raw.supporterTopRate, { max: 100 }),
    avgCritRate: clampNumber(raw.avgCritRate, { max: 100 }),
    avgCritDamageShare: clampNumber(raw.avgCritDamageShare, { max: 100 }),
    avgBackAttackRate: clampNumber(raw.avgBackAttackRate, { max: 100 }),
    avgFrontAttackRate: clampNumber(raw.avgFrontAttackRate, { max: 100 }),
    avgBackAttackDamageShare: clampNumber(raw.avgBackAttackDamageShare, { max: 100 }),
    avgFrontAttackDamageShare: clampNumber(raw.avgFrontAttackDamageShare, { max: 100 }),
    avgPositionalDamageShare: clampNumber(raw.avgPositionalDamageShare, { max: 100 }),
    attackStyle: cleanAttackStyle(raw.attackStyle),
    avgDamageTakenPerMinute: clampNumber(raw.avgDamageTakenPerMinute),
    damageTakenShareValidCount: clampNumber(raw.damageTakenShareValidCount, { max: 100000 }),
    avgDamageTakenShare: clampNumber(raw.avgDamageTakenShare, { max: 100 }),
    avgShieldReceivedPerMinute: clampNumber(raw.avgShieldReceivedPerMinute),
    avgStaggerPerMinute: clampNumber(raw.avgStaggerPerMinute),
    avgIncapacitations: clampNumber(raw.avgIncapacitations, { max: 1000 }),
    avgIncapacitationsPerMinute: clampNumber(raw.avgIncapacitationsPerMinute, { max: 1000 }),
    avgHyperShare: clampNumber(raw.avgHyperShare, { max: 100 }),
    avgUnbuffedDps: clampNumber(raw.avgUnbuffedDps),
    avgSupportBuffedShare: clampNumber(raw.avgSupportBuffedShare, { max: 999 }),
    avgSupportDebuffedShare: clampNumber(raw.avgSupportDebuffedShare, { max: 999 }),
    avgPartyBuffedShare: clampNumber(raw.avgPartyBuffedShare, { max: 999 }),
    avgSelfBuffedShare: clampNumber(raw.avgSelfBuffedShare, { max: 999 }),
    avgPartyDebuffedShare: clampNumber(raw.avgPartyDebuffedShare, { max: 999 }),
    avgBattleItemDebuffedShare: clampNumber(raw.avgBattleItemDebuffedShare, { max: 999 }),
    avgSynergyGivenPerMinute: clampNumber(raw.avgSynergyGivenPerMinute),
    avgSynergyReceivedShare: clampNumber(raw.avgSynergyReceivedShare, { max: 100 }),
    avgSkillCount: clampNumber(raw.avgSkillCount, { max: 1000 }),
    avgTopSkillShare: clampNumber(raw.avgTopSkillShare, { max: 100 }),
    avgProtectionPerMinute: clampNumber(raw.avgProtectionPerMinute),
    avgGearScore: clampNumber(raw.avgGearScore, { max: 9999 }),
    avgCombatPower: clampNumber(raw.avgCombatPower),
    arkPassiveRate: clampNumber(raw.arkPassiveRate, { max: 100 }),
  };
}

function cleanEncounterBuild(raw) {
  const build = cleanBuild(raw);
  const arkPassive = build.arkPassive || {};
  const compactTree = (tree = {}) => ({
    count: clampNumber(tree.count, { max: MAX_ARK_PASSIVE_NODES_PER_TREE }),
    points: clampNumber(tree.points, { max: 999 }),
    spentPoints: clampNumber(tree.spentPoints, { max: 999 }),
    spec: cleanShortString(tree.spec, 80),
  });
  return {
    classId: build.classId || 0,
    spec: build.spec || "",
    gearScore: build.gearScore || 0,
    combatPower: build.combatPower || 0,
    arkPassiveActive: build.arkPassiveActive,
    engravings: (build.engravings || []).slice(0, 4),
    arkPassive: {
      evolution: compactTree(arkPassive.evolution),
      enlightenment: compactTree(arkPassive.enlightenment),
      leap: compactTree(arkPassive.leap),
    },
  };
}

function cleanEncounterMetrics(raw) {
  const metrics = cleanNumberObject(raw, [
    "dps",
    "rdps",
    "ndps",
    "peak10sDps",
    "burstRatio",
    "activeDurationMs",
    "intermissionMs",
    "activeTimeRate",
    "damageDealt",
    "damageShare",
    "topDamageProximity",
    "contextSampleCount",
    "contextPerformancePercentile",
    "contextDamageSharePercentile",
    "contextTopDamageProximityPercentile",
    "contextSupportPercentile",
    "damageRank",
    "partyCount",
    "deathCount",
    "deadTimeMs",
    "deadTimeRate",
    "counters",
    "castsPerMinute",
    "hitsPerMinute",
    "critRate",
    "critDamageShare",
    "backAttackRate",
    "frontAttackRate",
    "backAttackDamageShare",
    "frontAttackDamageShare",
    "positionalDamageShare",
    "topSkillShare",
    "damageTakenPerMinute",
    "damageTakenShare",
    "shieldReceivedPerMinute",
    "staggerPerMinute",
    "incapacitations",
    "incapacitationsPerMinute",
    "hyperShare",
    "unbuffedShare",
    "supportBuffedShare",
    "supportDebuffedShare",
    "partyBuffedShare",
    "selfBuffedShare",
    "partyDebuffedShare",
    "battleItemDebuffedShare",
    "protectionPerMinute",
    "rdpsDamageGivenPerMinute",
    "rdpsDamageReceivedSupportPerMinute",
    "supporterDamageGiven",
    "supporterDamageGivenPerMinute",
    "supporterPercent",
    "supporterRank",
    "supporterCount",
    "synergyGivenPerMinute",
    "synergyReceivedShare",
  ], { max: 9999999999999 });
  metrics.rdpsValid = raw?.rdpsValid === true;
  metrics.supporterTier = cleanSupporterTier(raw?.supporterTier);
  metrics.contextSource = ["spec", "class"].includes(raw?.contextSource) ? raw.contextSource : "none";
  applyClampRules(metrics, [
    [[
      "damageShare",
      "contextPerformancePercentile",
      "contextDamageSharePercentile",
      "contextTopDamageProximityPercentile",
      "contextSupportPercentile",
      "deadTimeRate",
      "critRate",
      "critDamageShare",
      "backAttackRate",
      "frontAttackRate",
      "backAttackDamageShare",
      "frontAttackDamageShare",
      "positionalDamageShare",
      "topSkillShare",
      "damageTakenShare",
      "hyperShare",
      "unbuffedShare",
      "supportBuffedShare",
      "supportDebuffedShare",
      "partyBuffedShare",
      "selfBuffedShare",
      "partyDebuffedShare",
      "battleItemDebuffedShare",
      "supporterPercent",
      "synergyReceivedShare",
    ], { max: 999 }],
    [["activeTimeRate", "burstRatio", "topDamageProximity"], { max: 100 }],
    ["contextSampleCount", { max: 100000 }],
    [["damageRank", "partyCount", "deathCount", "counters", "incapacitations", "supporterRank", "supporterCount"], { max: 1000 }],
  ]);
  return metrics;
}

function cleanProfileEncounterSummary(raw, indexes, range, db) {
  if (!raw || typeof raw !== "object") return null;
  const accountName = cleanShortString(raw.accountName, 80);
  const characterName = cleanShortString(raw.characterName || raw.localPlayer || raw.name, 80);
  const rosterEntry = resolveRosterCharacter(indexes, accountName, characterName);
  if (!rosterEntry) return null;
  const fightStart = clampNumber(raw.fightStart, { max: 9999999999999 });
  if (!fightStart) return null;
  const boss = cleanShortString(raw.boss, 120);
  const raidKey = cleanShortString(raw.raidKey, 32);
  const modeKey = cleanShortString(raw.modeKey, 32);
  if (!boss || !raidKey || !modeKey) return null;
  const fallbackEncounterId = `${fightStart}:${boss}:${rosterEntry.charName}`;
  const encounterId = cleanShortString(raw.encounterId || fallbackEncounterId, 120);
  const className = rosterEntry.character?.class || cleanShortString(raw.class, 80);
  const classRole = roleForClass(className, raw.classRole);
  return {
    encounterId,
    accountName: rosterEntry.accountName,
    characterName: rosterEntry.charName,
    characterNameKey: normalizeKey(rosterEntry.charName),
    class: className,
    itemLevel: clampNumber(rosterEntry.character?.itemLevel, { max: 9999 }),
    classRole,
    role: cleanRole(raw.role, classRole),
    fightStart,
    durationMs: clampNumber(raw.durationMs, { max: 24 * 60 * 60 * 1000 }),
    boss,
    raidKey,
    modeKey,
    difficulty: cleanShortString(raw.difficulty, 80),
    rangeType: range.type,
    db,
    build: cleanEncounterBuild(raw.build),
    metrics: cleanEncounterMetrics(raw.metrics),
    topSkills: (Array.isArray(raw.topSkills) ? raw.topSkills : [])
      .slice(0, MAX_TOP_SKILLS_PER_ENCOUNTER)
      .map(cleanTopSkill)
      .filter(Boolean),
  };
}

function cleanProfileEncounterSummaries(rawList, indexes, range, db) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(rawList) ? rawList : []).slice(0, MAX_ENCOUNTER_SUMMARIES_PER_SYNC)) {
    const clean = cleanProfileEncounterSummary(raw, indexes, range, db);
    if (!clean) continue;
    const key = `${clean.encounterId}\x1f${clean.characterNameKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function cleanTopSkill(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    damage: clampNumber(raw.damage),
    share: clampNumber(raw.share, { max: 100 }),
    casts: clampNumber(raw.casts, { max: 100000 }),
    hits: clampNumber(raw.hits, { max: 1000000 }),
    critRate: clampNumber(raw.critRate, { max: 100 }),
    backAttackRate: clampNumber(raw.backAttackRate, { max: 100 }),
    frontAttackRate: clampNumber(raw.frontAttackRate, { max: 100 }),
    stagger: clampNumber(raw.stagger),
    isHyperAwakening: !!raw.isHyperAwakening,
  };
}

function cleanTopSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    category: cleanShortString(raw.category, 32) || "unknown",
    target: cleanShortString(raw.target, 16) || "UNKNOWN",
    amount: clampNumber(raw.amount),
    share: clampNumber(raw.share, { max: 999 }),
  };
}

function cleanBuildVariant(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name || raw.spec, 80);
  if (!name) return null;
  return {
    name,
    spec: cleanShortString(raw.spec || name, 80),
    role: cleanRole(raw.role),
    encounters: clampNumber(raw.encounters, { max: 100000 }),
    firstFightStart: clampNumber(raw.firstFightStart, { max: 9999999999999, fallback: null }),
    lastFightStart: clampNumber(raw.lastFightStart, { max: 9999999999999, fallback: null }),
    avgDps: clampNumber(raw.avgDps),
    medianDps: clampNumber(raw.medianDps),
    p90Dps: clampNumber(raw.p90Dps),
    avgRdps: clampNumber(raw.avgRdps),
    medianRdps: clampNumber(raw.medianRdps),
    avgNdps: clampNumber(raw.avgNdps),
    medianNdps: clampNumber(raw.medianNdps),
    avgDamageShare: clampNumber(raw.avgDamageShare, { max: 100 }),
    avgTopDamageProximity: clampNumber(raw.avgTopDamageProximity, { max: 100 }),
    avgBiblePercentile: clampNumber(raw.avgBiblePercentile, { max: 100 }),
    avgOverallBiblePercentile: clampNumber(raw.avgOverallBiblePercentile, { max: 100 }),
    avgContextPerformancePercentile: clampNumber(raw.avgContextPerformancePercentile, { max: 100 }),
    avgCritRate: clampNumber(raw.avgCritRate, { max: 100 }),
    avgBackAttackDamageShare: clampNumber(raw.avgBackAttackDamageShare, { max: 100 }),
    avgFrontAttackDamageShare: clampNumber(raw.avgFrontAttackDamageShare, { max: 100 }),
  };
}

function cleanEngraving(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    level: clampNumber(raw.level, { max: 10 }),
    isClass: !!raw.isClass,
  };
}

function cleanArkPassiveSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cleanNode = (value) => {
    if (!value || typeof value !== "object") return null;
    const id = Math.round(clampNumber(value.id, { max: 9999999 }));
    const level = Math.round(clampNumber(value.level ?? value.lv, { max: 100 }));
    if (!id || !level) return null;
    return {
      id,
      level,
      name: cleanShortString(value.name, 96),
      tier: Math.round(clampNumber(value.tier, { max: 10 })),
      position: Math.round(clampNumber(value.position, { max: 100 })),
      maxLevel: Math.round(clampNumber(value.maxLevel, { max: 100 })),
      points: clampNumber(value.points, { max: 1000 }),
    };
  };
  const cleanTree = (value) => {
    const nodes = (Array.isArray(value?.nodes) ? value.nodes : [])
      .slice(0, MAX_ARK_PASSIVE_NODES_PER_TREE)
      .map(cleanNode)
      .filter(Boolean);
    const tree = {
      count: clampNumber(value?.count, { max: 100, fallback: nodes.length }),
      points: clampNumber(value?.points, { max: 1000 }),
      spentPoints: clampNumber(value?.spentPoints, { max: 1000 }),
      nodes,
    };
    const spec = cleanShortString(value?.spec, 80);
    if (spec) tree.spec = spec;
    return tree;
  };
  return {
    evolution: cleanTree(raw.evolution),
    enlightenment: cleanTree(raw.enlightenment),
    leap: cleanTree(raw.leap),
  };
}

function cleanBuild(raw) {
  if (!raw || typeof raw !== "object") return {};
  return {
    classId: clampNumber(raw.classId, { max: 999999 }),
    spec: cleanShortString(raw.spec, 80),
    gearScore: clampNumber(raw.gearScore, { max: 9999 }),
    combatPower: clampNumber(raw.combatPower),
    arkPassiveActive: raw.arkPassiveActive === null || raw.arkPassiveActive === undefined
      ? null
      : !!raw.arkPassiveActive,
    engravings: (Array.isArray(raw.engravings) ? raw.engravings : [])
      .slice(0, MAX_ENGRAVINGS_PER_CHAR)
      .map(cleanEngraving)
      .filter(Boolean),
    arkPassive: cleanArkPassiveSummary(raw.arkPassive),
  };
}

function cleanCharacterProfile(rawChar, rosterEntry) {
  if (!rawChar || typeof rawChar !== "object" || !rosterEntry) return null;

  const stats = cleanNumberObject(rawChar.stats, CHARACTER_PROFILE_STATS_KEYS, { max: 9999999999999 });
  applyClampRules(stats, CHARACTER_PROFILE_STATS_CLAMP_RULES);
  stats.attackStyle = cleanAttackStyle(rawChar.stats?.attackStyle);

  const scores = cleanNumberObject(rawChar.scores, CHARACTER_PROFILE_SCORE_KEYS, { max: 100 });

  const raids = cleanLimitedList(rawChar.raids, MAX_RAID_BREAKDOWNS_PER_CHAR, cleanRaidBreakdown);
  const topSkills = cleanLimitedList(rawChar.topSkills, MAX_TOP_SKILLS_PER_CHAR, cleanTopSkill);
  const topBuffSources = cleanLimitedList(rawChar.topBuffSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topDebuffSources = cleanLimitedList(rawChar.topDebuffSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topShieldGivenSources = cleanLimitedList(rawChar.topShieldGivenSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topShieldReceivedSources = cleanLimitedList(rawChar.topShieldReceivedSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const buildVariants = cleanLimitedList(rawChar.buildVariants, MAX_BUILD_VARIANTS_PER_CHAR, cleanBuildVariant);

  const className = rosterEntry.character?.class || cleanShortString(rawChar.class, 80);
  const classRole = roleForClass(className, rawChar.classRole);
  return {
    name: rosterEntry.charName,
    class: className,
    itemLevel: clampNumber(rosterEntry.character?.itemLevel, { max: 9999 }),
    classRole,
    role: cleanRole(rawChar.role, classRole),
    stats,
    scores,
    build: cleanBuild(rawChar.build),
    topSkills,
    topBuffSources,
    topDebuffSources,
    topShieldGivenSources,
    topShieldReceivedSources,
    buildVariants,
    raids,
  };
}

function sanitizeSnapshotPayload(payload, userDoc) {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("profile payload required"), { status: 400 });
  }
  const rawRange = payload.criteria?.range || {};
  const minFightStartMs = clampNumber(rawRange.minFightStartMs, { max: 9999999999999, fallback: null });
  const range = rawRange?.type === "weekly" && minFightStartMs > 0
    ? {
        type: "weekly",
        minFightStartMs,
      }
    : { type: "full" };
  const indexes = buildRosterIndexes(userDoc);
  const accountsByName = new Map();
  let rejected = 0;

  for (const rawAccount of (Array.isArray(payload.accounts) ? payload.accounts : []).slice(0, MAX_ACCOUNTS)) {
    const rawAccountName = cleanShortString(rawAccount?.accountName, 80);
    if (!rawAccountName) continue;
    for (const rawChar of (Array.isArray(rawAccount?.characters) ? rawAccount.characters : []).slice(0, MAX_CHARACTERS_PER_ACCOUNT)) {
      const rosterEntry = resolveRosterCharacter(indexes, rawAccountName, rawChar?.name);
      if (!rosterEntry) {
        rejected += 1;
        continue;
      }
      const cleanChar = cleanCharacterProfile(rawChar, rosterEntry);
      if (!cleanChar) {
        rejected += 1;
        continue;
      }
      const accountName = rosterEntry.accountName || rawAccountName;
      if (!accountsByName.has(accountName)) {
        accountsByName.set(accountName, { accountName, characters: [] });
      }
      const bucket = accountsByName.get(accountName);
      if (!bucket.characters.some((c) => normalizeKey(c.name) === normalizeKey(cleanChar.name))) {
        bucket.characters.push(cleanChar);
      }
    }
  }

  const accounts = [...accountsByName.values()]
    .filter((account) => account.characters.length > 0)
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  let characterCount = 0;
  let encounterCount = 0;
  let firstFightStart = null;
  let lastFightStart = null;
  for (const account of accounts) {
    account.characters.sort((a, b) => a.name.localeCompare(b.name));
    characterCount += account.characters.length;
    for (const character of account.characters) {
      encounterCount += Number(character.stats?.encounters) || 0;
      const first = Number(character.stats?.firstFightStart) || 0;
      const last = Number(character.stats?.lastFightStart) || 0;
      if (first && (!firstFightStart || first < firstFightStart)) firstFightStart = first;
      if (last && (!lastFightStart || last > lastFightStart)) lastFightStart = last;
    }
  }

  const db = {
    fileName: cleanShortString(payload.db?.fileName, 160),
    size: clampNumber(payload.db?.size, { max: 100 * 1024 * 1024 * 1024 }),
    lastModified: clampNumber(payload.db?.lastModified, { max: 9999999999999, fallback: null }),
  };
  const encounterSummaries = cleanProfileEncounterSummaries(payload.encounters, indexes, range, db);

  return {
    version: PROFILE_VERSION,
    source: "local",
    rangeType: range.type,
    generatedAt: clampNumber(payload.generatedAt, { max: 9999999999999, fallback: Date.now() }),
    receivedAt: Date.now(),
    criteria: {
      clearedOnly: true,
      supportedBossesOnly: true,
      minDurationMs: 180000,
      modernProfileStatsOnly: payload.criteria?.modernProfileStatsOnly !== false,
      source: "encounters.db",
      range,
    },
    db,
    totals: {
      accountCount: accounts.length,
      characterCount,
      encounterCount,
      encounterSummaryCount: encounterSummaries.length,
      firstFightStart,
      lastFightStart,
      rejectedCharacters: rejected,
    },
    accounts,
    encounterSummaries,
  };
}

module.exports = {
  PROFILE_VERSION,
  MAX_BODY_BYTES,
  sanitizeSnapshotPayload,
};
