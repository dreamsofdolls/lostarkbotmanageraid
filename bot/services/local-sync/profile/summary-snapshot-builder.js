"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const {
  PROFILE_VERSION,
} = require("./payload-sanitizer");
const {
  normalizeKey,
  roleForClass,
} = require("./sanitizer/common");

const MIN_ALT_BUILD_LOGS = 3;

const PROFILE_METRICS_MODULE_URL = pathToFileURL(path.join(
  __dirname,
  "../../../../web/js/profile/metrics/profile-metrics.js"
)).href;
const PROFILE_SCORE_MODULE_URL = pathToFileURL(path.join(
  __dirname,
  "../../../../web/js/profile/metrics/profile-score.js"
)).href;

let profileScoringModulesPromise = null;

function loadProfileScoringModules() {
  if (!profileScoringModulesPromise) {
    profileScoringModulesPromise = Promise.all([
      import(PROFILE_METRICS_MODULE_URL),
      import(PROFILE_SCORE_MODULE_URL),
    ]).then(([metrics, score]) => ({
      computeProfileConsistency: metrics.computeProfileConsistency,
      computeScores: score.computeProfileScores,
      MIN_CONTEXT_SAMPLE_COUNT: score.MIN_CONTEXT_SAMPLE_COUNT,
    }));
  }
  return profileScoringModulesPromise;
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  return Math.round((finite(value) || 0) * 10) / 10;
}

function round2(value) {
  return Math.round((finite(value) || 0) * 100) / 100;
}

function average(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function percentile(values, p) {
  const nums = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function minPositive(values) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : null;
}

function maxPositive(values) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

function cleanBuildName(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim().slice(0, 80);
}

function buildVariantIdentity(row) {
  const spec = cleanBuildName(row?.arkPassive?.enlightenment?.spec || row?.spec || "");
  if (spec) return { key: `spec:${normalizeKey(spec)}`, name: spec, known: true };
  const classEngraving = (row?.engravings || []).find((entry) => entry?.isClass && entry?.name);
  if (classEngraving?.name) {
    const name = cleanBuildName(classEngraving.name);
    return { key: `class:${normalizeKey(name)}`, name, known: true };
  }
  return { key: "unknown", name: "Unknown build", known: false };
}

function buildVariantKey(row) {
  const identity = buildVariantIdentity(row);
  return identity.known ? identity.key : "";
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
        name: group.identity.name,
        spec: group.identity.name,
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

function classifyAttackStyle(backRate, frontRate) {
  const back = Number(backRate) || 0;
  const front = Number(frontRate) || 0;
  if (back >= 45 && back >= front) return "back";
  if (front >= 45) return "front";
  return "hit_master";
}

function summaryToRow(summary) {
  const metrics = summary?.metrics || {};
  const build = summary?.build || {};
  const activeDurationMs = finite(metrics.activeDurationMs, summary?.durationMs || 0);
  const activeMinutes = activeDurationMs > 0 ? activeDurationMs / 60000 : Math.max(0, finite(summary?.durationMs) / 60000);
  const protectionPerMinute = finite(metrics.protectionPerMinute);
  const damageTakenShare = finite(metrics.damageTakenShare);
  return {
    encounterId: String(summary?.encounterId || ""),
    accountName: String(summary?.accountName || ""),
    localPlayer: String(summary?.characterName || ""),
    className: String(summary?.class || ""),
    itemLevel: finite(summary?.itemLevel),
    classRole: summary?.classRole || roleForClass(summary?.class),
    logRole: summary?.role || summary?.classRole || roleForClass(summary?.class),
    boss: String(summary?.boss || ""),
    raidKey: String(summary?.raidKey || ""),
    modeKey: String(summary?.modeKey || ""),
    difficulty: String(summary?.difficulty || ""),
    fightStart: finite(summary?.fightStart),
    durationMs: finite(summary?.durationMs),
    dps: finite(metrics.dps),
    rdps: finite(metrics.rdps),
    ndps: finite(metrics.ndps),
    peak10sDps: finite(metrics.peak10sDps),
    burstRatio: finite(metrics.burstRatio),
    rdpsValid: metrics.rdpsValid === true,
    activeDurationMs,
    intermissionMs: finite(metrics.intermissionMs),
    activeTimeRate: finite(metrics.activeTimeRate),
    damageDealt: finite(metrics.damageDealt),
    damageShare: finite(metrics.damageShare),
    topDamageProximity: finite(metrics.topDamageProximity),
    contextSampleCount: finite(metrics.contextSampleCount),
    contextSource: metrics.contextSource || "none",
    contextPerformancePercentile: finite(metrics.contextPerformancePercentile),
    contextDamageSharePercentile: finite(metrics.contextDamageSharePercentile),
    contextTopDamageProximityPercentile: finite(metrics.contextTopDamageProximityPercentile),
    contextSupportPercentile: finite(metrics.contextSupportPercentile),
    damageRank: finite(metrics.damageRank),
    partyCount: finite(metrics.partyCount),
    deathCount: finite(metrics.deathCount),
    deadTimeMs: finite(metrics.deadTimeMs),
    deadTimeRate: finite(metrics.deadTimeRate),
    counters: finite(metrics.counters),
    castsPerMinute: finite(metrics.castsPerMinute),
    hitsPerMinute: finite(metrics.hitsPerMinute),
    critRate: finite(metrics.critRate),
    critDamageShare: finite(metrics.critDamageShare),
    backAttackRate: finite(metrics.backAttackRate),
    frontAttackRate: finite(metrics.frontAttackRate),
    backAttackDamageShare: finite(metrics.backAttackDamageShare),
    frontAttackDamageShare: finite(metrics.frontAttackDamageShare),
    positionalDamageShare: finite(metrics.positionalDamageShare),
    topSkillShare: finite(metrics.topSkillShare),
    hasDamageStats: true,
    damageTaken: 0,
    damageTakenPerMinute: finite(metrics.damageTakenPerMinute),
    damageTakenShare,
    damageTakenShareValid: damageTakenShare > 0,
    damageAbsorbed: 0,
    shieldsReceived: 0,
    shieldReceivedPerMinute: finite(metrics.shieldReceivedPerMinute),
    stagger: 0,
    staggerPerMinute: finite(metrics.staggerPerMinute),
    incapacitations: finite(metrics.incapacitations),
    incapacitationsPerMinute: finite(metrics.incapacitationsPerMinute),
    hyperShare: finite(metrics.hyperShare),
    unbuffedShare: finite(metrics.unbuffedShare),
    unbuffedDps: 0,
    supportBuffedShare: finite(metrics.supportBuffedShare),
    supportDebuffedShare: finite(metrics.supportDebuffedShare),
    supportAp: finite(metrics.supportAp),
    supportBrand: finite(metrics.supportBrand),
    supportIdentity: finite(metrics.supportIdentity),
    supportHyper: finite(metrics.supportHyper),
    partyBuffedShare: finite(metrics.partyBuffedShare),
    selfBuffedShare: finite(metrics.selfBuffedShare),
    partyDebuffedShare: finite(metrics.partyDebuffedShare),
    battleItemDebuffedShare: finite(metrics.battleItemDebuffedShare),
    protection: activeMinutes > 0 ? protectionPerMinute * activeMinutes : 0,
    protectionPerMinute,
    rdpsDamageGivenPerMinute: finite(metrics.rdpsDamageGivenPerMinute),
    rdpsDamageGivenShare: finite(metrics.rdpsDamageGivenShare),
    rdpsDamageReceivedSupportPerMinute: finite(metrics.rdpsDamageReceivedSupportPerMinute),
    rdpsDamageReceivedSupport: activeMinutes > 0 ? finite(metrics.rdpsDamageReceivedSupportPerMinute) * activeMinutes : 0,
    supporterDamageGiven: finite(metrics.supporterDamageGiven),
    supporterDamageGivenPerMinute: finite(metrics.supporterDamageGivenPerMinute),
    supporterPercent: finite(metrics.supporterPercent),
    supporterTier: metrics.supporterTier || "none",
    supporterRank: finite(metrics.supporterRank),
    supporterCount: finite(metrics.supporterCount),
    synergyGivenPerMinute: finite(metrics.synergyGivenPerMinute),
    synergyGivenShare: finite(metrics.synergyGivenShare),
    synergyReceivedShare: finite(metrics.synergyReceivedShare),
    classId: finite(build.classId),
    spec: cleanBuildName(build.arkPassive?.enlightenment?.spec || build.spec),
    gearScore: finite(build.gearScore),
    combatPower: finite(build.combatPower),
    arkPassiveActive: build.arkPassiveActive === null || build.arkPassiveActive === undefined ? null : !!build.arkPassiveActive,
    engravings: Array.isArray(build.engravings) ? build.engravings : [],
    arkPassive: build.arkPassive || null,
    topSkills: Array.isArray(summary?.topSkills) ? summary.topSkills : [],
    topBuffSources: [],
    topDebuffSources: [],
    topShieldGivenSources: [],
    topShieldReceivedSources: [],
  };
}

function mergeTopSkills(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    for (const skill of row.topSkills || []) {
      const key = skill.id || normalizeKey(skill.name);
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

function summarizeGroup(rows, minContextSampleCount) {
  const dps = rows.map((r) => r.dps);
  const peak10sDps = rows.map((r) => r.peak10sDps).filter((n) => n > 0);
  const burstRatios = rows.map((r) => r.burstRatio).filter((n) => n > 0);
  const shares = rows.map((r) => r.damageShare);
  const ranks = rows.map((r) => r.damageRank).filter((n) => n > 0);
  const damageRows = rows.filter((r) => r.hasDamageStats);
  const deathCounts = rows.map((r) => Number(r.deathCount) || 0);
  const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const deadTimes = rows.map((r) => Number(r.deadTimeMs) || 0);
  const totalDeadTimeMs = deadTimes.reduce((sum, n) => sum + n, 0);
  const damageTakenShareRows = damageRows.filter((r) => r.damageTakenShareValid);
  const rdpsValidRows = rows.filter((r) => r.rdpsValid);
  const supporterRows = rdpsValidRows.length ? rdpsValidRows : rows;
  const supporterPercents = supporterRows.map((r) => Number(r.supporterPercent) || 0);
  const radiantSupportCount = supporterRows.filter((r) => r.supporterTier === "radiant").length;
  const supporterRankRows = supporterRows.filter((r) => (Number(r.supporterRank) || 0) > 0 && (Number(r.supporterCount) || 0) > 0);
  const supporterCompetitiveRows = supporterRankRows.filter((r) => (Number(r.supporterCount) || 0) > 1);
  const contextRows = rows.filter((r) => (Number(r.contextSampleCount) || 0) >= minContextSampleCount && r.contextSource !== "none");
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
    p75Dps: Math.round(percentile(dps, 75)),
    p90Dps: Math.round(percentile(dps, 90)),
    avgPeak10sDps: Math.round(average(peak10sDps)),
    p90Peak10sDps: Math.round(percentile(peak10sDps, 90)),
    avgBurstRatio: round2(average(burstRatios)),
    avgRdps: Math.round(average(rows.map((r) => r.rdps))),
    medianRdps: Math.round(percentile(rows.map((r) => r.rdps), 50)),
    avgNdps: Math.round(average(rows.map((r) => r.ndps))),
    medianNdps: Math.round(percentile(rows.map((r) => r.ndps), 50)),
    avgDamageShare: round1(average(shares)),
    medianDamageShare: round1(percentile(shares, 50)),
    avgTopDamageProximity: round1(average(rows.map((r) => r.topDamageProximity))),
    contextCoverageRate: round1(rows.length ? (contextRows.length / rows.length) * 100 : 0),
    contextSampleCountAvg: round1(average(contextRows.map((r) => r.contextSampleCount))),
    avgContextPerformancePercentile: round1(average(contextRows.map((r) => r.contextPerformancePercentile))),
    avgContextDamageSharePercentile: round1(average(dpsContextRows.map((r) => r.contextDamageSharePercentile))),
    avgContextTopDamageProximityPercentile: round1(average(dpsContextRows.map((r) => r.contextTopDamageProximityPercentile))),
    avgContextSupportPercentile: round1(average(supportContextRows.map((r) => r.contextSupportPercentile))),
    topRate: round1(rows.length ? (rows.filter((r) => r.damageRank === 1).length / rows.length) * 100 : 0),
    avgRank: round2(average(ranks)),
    partyCountAvg: round2(average(rows.map((r) => r.partyCount).filter((n) => n > 0))),
    deathlessRate: round1(rows.length ? ((rows.length - deathRows) / rows.length) * 100 : 0),
    deathRate: round1(rows.length ? (deathRows / rows.length) * 100 : 0),
    totalDeaths,
    avgDeaths: round2(average(deathCounts)),
    totalDeadTimeMs: Math.round(totalDeadTimeMs),
    avgDeadTimeMs: Math.round(average(deadTimes)),
    avgDeadTimeRate: round1(average(rows.map((r) => r.deadTimeRate))),
    rdpsValidCount: rdpsValidRows.length,
    rdpsValidRate: round1(rows.length ? (rdpsValidRows.length / rows.length) * 100 : 0),
    avgSupporterPercent: round1(average(supporterPercents)),
    medianSupporterPercent: round1(percentile(supporterPercents, 50)),
    radiantSupportCount,
    radiantSupportRate: round1(supporterRows.length ? (radiantSupportCount / supporterRows.length) * 100 : 0),
    avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((r) => r.supporterDamageGivenPerMinute))),
    avgRdpsDamageGivenShare: round1(average(rdpsValidRows.map((r) => r.rdpsDamageGivenShare))),
    supporterRankValidCount: supporterRankRows.length,
    supporterCompetitiveCount: supporterCompetitiveRows.length,
    avgSupporterRank: round2(average(supporterRankRows.map((r) => r.supporterRank))),
    supporterCountAvg: round2(average(supporterRankRows.map((r) => r.supporterCount))),
    supporterTopRate: round1(supporterCompetitiveRows.length
      ? (supporterCompetitiveRows.filter((r) => r.supporterRank === 1).length / supporterCompetitiveRows.length) * 100
      : 0),
    avgCounters: round2(average(rows.map((r) => r.counters))),
    avgCastsPerMinute: round2(average(rows.map((r) => r.castsPerMinute))),
    avgHitsPerMinute: round2(average(rows.map((r) => r.hitsPerMinute))),
    avgCritRate: round1(average(rows.map((r) => r.critRate))),
    avgCritDamageShare: round1(average(rows.map((r) => r.critDamageShare))),
    avgBackAttackRate,
    avgFrontAttackRate,
    avgBackAttackDamageShare,
    avgFrontAttackDamageShare,
    avgPositionalDamageShare: round1(average(rows.map((r) => r.positionalDamageShare))),
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
    avgSkillCount: round1(average(rows.map((r) => (r.topSkills || []).length))),
    avgTopSkillShare: round1(average(rows.map((r) => r.topSkillShare))),
    avgRdpsDamageGiven: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGiven))),
    avgRdpsDamageGivenPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGivenPerMinute))),
    avgRdpsDamageReceivedSupport: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupport))),
    avgRdpsDamageReceivedSupportPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupportPerMinute))),
    avgSynergyGiven: Math.round(average(rows.map((r) => r.synergyGiven))),
    avgSynergyGivenPerMinute: Math.round(average(rows.map((r) => r.synergyGivenPerMinute))),
    avgSynergyGivenShare: round1(average(rows.map((r) => r.synergyGivenShare))),
    avgSynergyReceivedShare: round1(average(rows.map((r) => r.synergyReceivedShare))),
    avgSupportAp: round2(average(rows.map((r) => r.supportAp))),
    avgSupportBrand: round2(average(rows.map((r) => r.supportBrand))),
    avgSupportIdentity: round2(average(rows.map((r) => r.supportIdentity))),
    avgSupportHyper: round2(average(rows.map((r) => r.supportHyper))),
    avgProtection: Math.round(average(rows.map((r) => r.protection))),
    avgProtectionPerMinute: Math.round(average(rows.map((r) => r.protectionPerMinute))),
    avgGearScore: round2(average(rows.map((r) => r.gearScore).filter((n) => n > 0))),
    latestGearScore: round2(rows[0]?.gearScore),
    avgCombatPower: round2(average(rows.map((r) => r.combatPower).filter((n) => n > 0))),
    latestCombatPower: round2(rows[0]?.combatPower),
    arkPassiveRate: arkRows.length ? round1((arkRows.filter((r) => r.arkPassiveActive).length / arkRows.length) * 100) : 0,
  };
}

async function computeBuildStats(rows, role, buildVariants, scoring = null) {
  const profileScoring = scoring || await loadProfileScoringModules();
  const stats = summarizeGroup(rows, profileScoring.MIN_CONTEXT_SAMPLE_COUNT);
  stats.buildVariantCount = Math.max(new Set(rows.map(buildVariantKey).filter(Boolean)).size, buildVariants.length);
  stats.unclassifiedBuildLogCount = countUnclassifiedBuildRows(rows);
  stats.consistency = profileScoring.computeProfileConsistency(rows, role);
  return stats;
}

function buildProfileBuild(row) {
  return {
    classId: row?.classId || 0,
    spec: cleanBuildName(row?.arkPassive?.enlightenment?.spec || row?.spec),
    gearScore: round2(row?.gearScore),
    combatPower: round2(row?.combatPower),
    arkPassiveActive: row?.arkPassiveActive === null || row?.arkPassiveActive === undefined ? null : !!row?.arkPassiveActive,
    engravings: row?.engravings || [],
    arkPassive: row?.arkPassive || null,
  };
}

function summarizeRaidGroup(rows, scoring) {
  return {
    raidKey: rows[0]?.raidKey || "",
    modeKey: rows[0]?.modeKey || "",
    boss: rows[0]?.boss || "",
    ...summarizeGroup(rows, scoring.MIN_CONTEXT_SAMPLE_COUNT),
  };
}

async function buildSnapshotFromEncounterSummaries({
  summaries,
  base,
  rangeType = "weekly",
  rangeStart = 0,
  nowMs = Date.now(),
}) {
  const rows = (summaries || []).map(summaryToRow).filter((row) => row.localPlayer && row.fightStart);
  if (!rows.length) return null;

  const scoring = await loadProfileScoringModules();
  const byChar = new Map();
  for (const row of rows) {
    const key = `${normalizeKey(row.accountName)}\x1f${normalizeKey(row.localPlayer)}`;
    if (!byChar.has(key)) byChar.set(key, []);
    byChar.get(key).push(row);
  }

  const accountsByName = new Map();
  for (const allCharRowsRaw of byChar.values()) {
    const allCharRows = [...allCharRowsRaw].sort((a, b) => (b.fightStart || 0) - (a.fightStart || 0));
    const classRole = allCharRows[0]?.classRole || roleForClass(allCharRows[0]?.className);
    const supportRows = allCharRows.filter((row) => row.logRole === "support");
    const dpsBuildRows = allCharRows.filter((row) => row.logRole === "dps");
    const role = classRole === "support"
      ? (supportRows.length > 0 ? "support" : "dps")
      : classRole;
    const roleRows = classRole === "support"
      ? (role === "support" ? supportRows : dpsBuildRows)
      : allCharRows;
    const profileRows = roleRows.length ? roleRows : allCharRows;
    const sample = profileRows[0];
    const latestRow = profileRows.reduce((best, row) =>
      (Number(row.fightStart) || 0) > (Number(best.fightStart) || 0) ? row : best
    , sample);
    const buildVariants = summarizeBuildVariants(profileRows);
    const stats = {
      ...await computeBuildStats(profileRows, role, buildVariants, scoring),
      allEncounterCount: allCharRows.length,
      supportLogCount: supportRows.length,
      dpsBuildLogCount: classRole === "support" ? dpsBuildRows.length : 0,
      supportLogRate: allCharRows.length ? round1((supportRows.length / allCharRows.length) * 100) : 0,
      dpsBuildLogRate: classRole === "support" && allCharRows.length ? round1((dpsBuildRows.length / allCharRows.length) * 100) : 0,
      primaryRoleRate: allCharRows.length ? round1((profileRows.length / allCharRows.length) * 100) : 0,
    };

    let altBuild = null;
    if (classRole === "support") {
      const altRole = role === "support" ? "dps" : "support";
      const altRows = role === "support" ? dpsBuildRows : supportRows;
      if (altRows.length >= MIN_ALT_BUILD_LOGS) {
        const altStats = await computeBuildStats(altRows, altRole, summarizeBuildVariants(altRows), scoring);
        const altLatestRow = altRows.reduce((best, row) =>
          (Number(row.fightStart) || 0) > (Number(best.fightStart) || 0) ? row : best
        , altRows[0]);
        altBuild = {
          role: altRole,
          encounters: altRows.length,
          stats: altStats,
          scores: scoring.computeScores(altStats, altRole),
          build: buildProfileBuild(altLatestRow),
        };
      }
    }

    const raidGroups = new Map();
    for (const row of profileRows) {
      const groupKey = `${row.raidKey}\x1f${row.modeKey}\x1f${row.boss}`;
      if (!raidGroups.has(groupKey)) raidGroups.set(groupKey, []);
      raidGroups.get(groupKey).push(row);
    }
    const raids = [...raidGroups.values()]
      .map((raidRows) => summarizeRaidGroup(raidRows, scoring))
      .sort((a, b) => (b.lastFightStart || 0) - (a.lastFightStart || 0));

    const accountName = sample.accountName || "";
    if (!accountsByName.has(accountName)) accountsByName.set(accountName, { accountName, characters: [] });
    accountsByName.get(accountName).characters.push({
      name: sample.localPlayer,
      class: sample.className,
      itemLevel: sample.itemLevel,
      classRole,
      role,
      stats,
      scores: scoring.computeScores(stats, role),
      altBuild,
      build: buildProfileBuild(latestRow),
      topSkills: mergeTopSkills(profileRows),
      topBuffSources: [],
      topDebuffSources: [],
      topShieldGivenSources: [],
      topShieldReceivedSources: [],
      buildVariants,
      raids,
    });
  }

  const accounts = [...accountsByName.values()]
    .map((account) => ({
      accountName: account.accountName,
      characters: account.characters.sort((a, b) => b.stats.encounters - a.stats.encounters || a.name.localeCompare(b.name)),
    }))
    .filter((account) => account.characters.length > 0)
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  let characterCount = 0;
  let encounterCount = 0;
  let firstFightStart = null;
  let lastFightStart = null;
  for (const account of accounts) {
    characterCount += account.characters.length;
    for (const character of account.characters) {
      encounterCount += Number(character.stats?.encounters) || 0;
      const first = Number(character.stats?.firstFightStart) || 0;
      const last = Number(character.stats?.lastFightStart) || 0;
      if (first && (!firstFightStart || first < firstFightStart)) firstFightStart = first;
      if (last && (!lastFightStart || last > lastFightStart)) lastFightStart = last;
    }
  }

  return {
    version: PROFILE_VERSION,
    source: "local",
    rangeType,
    generatedAt: nowMs,
    receivedAt: nowMs,
    criteria: {
      ...(base?.criteria || {}),
      source: "encounters.db",
      range: rangeType === "weekly"
        ? {
            ...(base?.criteria?.range || {}),
            type: "weekly",
            minFightStartMs: rangeStart || base?.criteria?.range?.minFightStartMs || firstFightStart,
          }
        : { type: "full" },
    },
    db: base?.db || {},
    totals: {
      accountCount: accounts.length,
      characterCount,
      encounterCount,
      encounterSummaryCount: summaries.length,
      firstFightStart,
      lastFightStart,
      rejectedCharacters: 0,
    },
    accounts,
  };
}

function buildRosterKeySet(userDoc) {
  const keys = new Set();
  for (const account of userDoc?.accounts || []) {
    for (const character of account?.characters || []) {
      const accountKey = normalizeKey(account.accountName);
      const charKey = normalizeKey(character.name);
      if (accountKey && charKey) keys.add(`${accountKey}\x1f${charKey}`);
    }
  }
  return keys;
}

function filterSummariesForRoster(summaries, userDoc) {
  const rosterKeys = buildRosterKeySet(userDoc);
  if (!rosterKeys.size) return [];
  return (summaries || []).filter((summary) =>
    rosterKeys.has(`${normalizeKey(summary?.accountName)}\x1f${normalizeKey(summary?.characterName)}`)
  );
}

async function readLocalEncounterSummaries({ discordId, minFightStartMs = 0, RaidProfileEncounter }) {
  if (!RaidProfileEncounter || typeof RaidProfileEncounter.find !== "function") return [];
  const filter = {
    discordId,
    $or: [
      { "db.source": { $exists: false } },
      { "db.source": { $ne: "lostark.bible" } },
    ],
  };
  if (Number(minFightStartMs) > 0) filter.fightStart = { $gte: Number(minFightStartMs) || 0 };
  const query = RaidProfileEncounter.find(filter);
  if (query && typeof query.sort === "function") {
    return await query.sort({ fightStart: 1 }).lean();
  }
  if (query && typeof query.lean === "function") {
    return await query.lean();
  }
  return Array.isArray(query) ? query : [];
}

async function rebuildWeeklySnapshotFromStoredSummaries({
  discordId,
  clean,
  userDoc,
  RaidProfileEncounter,
  nowMs = Date.now(),
}) {
  const range = clean?.criteria?.range || {};
  if (range.type !== "weekly" || !(Number(range.minFightStartMs) > 0)) return null;
  const stored = await readLocalEncounterSummaries({
    discordId,
    minFightStartMs: range.minFightStartMs,
    RaidProfileEncounter,
  });
  const summaries = filterSummariesForRoster(stored, userDoc);
  if (!summaries.length) return null;
  const snapshot = await buildSnapshotFromEncounterSummaries({
    summaries,
    base: clean,
    rangeType: "weekly",
    rangeStart: Number(range.minFightStartMs) || 0,
    nowMs,
  });
  if (!snapshot) return null;
  return {
    ...snapshot,
    encounterSummaries: clean.encounterSummaries,
  };
}

async function rebuildFullSnapshotFromStoredSummaries({
  discordId,
  clean,
  userDoc,
  RaidProfileEncounter,
  nowMs = Date.now(),
}) {
  const stored = await readLocalEncounterSummaries({
    discordId,
    RaidProfileEncounter,
  });
  const summaries = filterSummariesForRoster(stored, userDoc);
  if (!summaries.some((summary) => summary?.rangeType === "full")) return null;
  const snapshot = await buildSnapshotFromEncounterSummaries({
    summaries,
    base: {
      ...clean,
      criteria: {
        ...(clean?.criteria || {}),
        range: { type: "full" },
      },
    },
    rangeType: "full",
    nowMs,
  });
  if (!snapshot) return null;
  return {
    ...snapshot,
    encounterSummaries: clean.encounterSummaries,
  };
}

module.exports = {
  __test: {
    loadProfileScoringModules,
  },
  buildSnapshotFromEncounterSummaries,
  rebuildFullSnapshotFromStoredSummaries,
  rebuildWeeklySnapshotFromStoredSummaries,
  summaryToRow,
};
