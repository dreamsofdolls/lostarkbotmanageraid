"use strict";

const {
  MAX_ARK_PASSIVE_NODES_PER_TREE,
  MAX_ENCOUNTER_SUMMARIES_PER_SYNC,
  MAX_TOP_SKILLS_PER_ENCOUNTER,
} = require("./constants");
const {
  applyClampRules,
  clampNumber,
  cleanNumberObject,
  cleanRole,
  cleanShortString,
  cleanSupporterTier,
  normalizeKey,
  roleForClass,
} = require("./common");
const {
  cleanBuild,
} = require("./build");
const {
  cleanTopSkill,
} = require("./items");
const {
  resolveRosterCharacter,
} = require("./roster");

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
    "supportAp",
    "supportBrand",
    "supportIdentity",
    "supportHyper",
    "partyBuffedShare",
    "selfBuffedShare",
    "partyDebuffedShare",
    "battleItemDebuffedShare",
    "protectionPerMinute",
    "rdpsDamageGivenPerMinute",
    "rdpsDamageGivenShare",
    "rdpsDamageReceivedSupportPerMinute",
    "supporterDamageGiven",
    "supporterDamageGivenPerMinute",
    "supporterPercent",
    "supporterRank",
    "supporterCount",
    "synergyGivenPerMinute",
    "synergyGivenShare",
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
      "supportAp",
      "supportBrand",
      "supportIdentity",
      "supportHyper",
      "partyBuffedShare",
      "selfBuffedShare",
      "partyDebuffedShare",
      "battleItemDebuffedShare",
      "supporterPercent",
      "rdpsDamageGivenShare",
      "synergyGivenShare",
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

module.exports = {
  cleanProfileEncounterSummaries,
};
