"use strict";

import {
  getArkPassiveNodeMeta,
  getSpecFromArkPassiveNodes,
} from "/sync/js/profile/data/ark-passive-data.js";
import {
  classifyProfileLogRole,
  roleForProfileClass,
  stripMarkup,
} from "/sync/js/profile/profile-role.js";
import { MIN_CONTEXT_SAMPLE_COUNT } from "/sync/js/profile/metrics/profile-score.js";

const POSITIONAL_ATTACK_RATE_THRESHOLD = 45;
export function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

export function average(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

export function percentile(values, p) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

export function minPositive(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : 0;
}

export function maxPositive(values) {
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

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
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

export function classifyAttackStyle(backRate, frontRate) {
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

export function cleanBuildName(value) {
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

export function buildVariantKey(row) {
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

export function buildVariantName(row) {
  return buildVariantIdentity(row).name;
}

export function countUnclassifiedBuildRows(rows) {
  return (rows || []).filter((row) => !buildVariantIdentity(row).known).length;
}

export function summarizeBuildVariants(rows, { limit = 6 } = {}) {
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

export async function enrichProfileRows(rows) {
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
    row.encounterDamageDealt = row.encounterTotalDamageDealt ||
      (row.partyDps > 0 && row.durationMs > 0 ? Math.round(row.partyDps * (row.durationMs / 1000)) : 0);
    row.rdpsDamageGivenPerMinute = activeDurationMin > 0 ? row.rdpsDamageGiven / activeDurationMin : 0;
    row.rdpsDamageReceivedSupportPerMinute = activeDurationMin > 0 ? row.rdpsDamageReceivedSupport / activeDurationMin : 0;
    row.rdpsDamageGivenShare = row.encounterDamageDealt > 0
      ? (row.rdpsDamageGiven / row.encounterDamageDealt) * 100
      : 0;
    const contribution = extractContributionMetrics(misc, row.localPlayer, row.damageDealt);
    row.partyNumber = Number.isFinite(contribution.partyNumber) ? contribution.partyNumber : null;
    row.synergyGiven = contribution.synergyGiven;
    row.synergyReceived = contribution.synergyReceived;
    row.synergyGivenPerMinute = activeDurationMin > 0 ? contribution.synergyGiven / activeDurationMin : 0;
    row.synergyGivenShare = row.encounterDamageDealt > 0
      ? (contribution.synergyGiven / row.encounterDamageDealt) * 100
      : 0;
    row.synergyReceivedShare = contribution.synergyReceivedShare;
    row.damageShare = row.partyDps > 0 ? (row.dps / row.partyDps) * 100 : 0;
    row.classRole = roleForProfileClass(row.className);
    row.logRole = classifyProfileLogRole(row);
    const supportLog = row.classRole === "support" && row.logRole === "support" && row.rdpsValid;
    row.supporterRank = supportLog ? Math.max(0, Number(row.supporterRank) || 0) : 0;
    row.supporterCount = supportLog ? Math.max(0, Number(row.supporterCount) || 0) : 0;
    row.supporterTop = row.supporterCount > 1 && row.supporterRank === 1 ? 1 : 0;
    row.supporterDamageGiven = supportLog ? Math.max(0, Number(row.rdpsDamageGiven) || 0) : 0;
    row.supporterDamageGivenPerMinute = activeDurationMin > 0 ? row.supporterDamageGiven / activeDurationMin : 0;
    row.supporterPercent = supportLog ? row.rdpsDamageGivenShare : 0;
    row.supporterTier = classifySupporterTier(row.supporterPercent);
    Object.assign(row, selectContextPercentiles(row, row.logRole));
  }));
}

export function isModernProfileRow(row) {
  return !!row?.hasDamageStats &&
    (Number(row.damageDealt) || 0) > 0 &&
    (Number(row.hits) || 0) > 0 &&
    (Number(row.skillCount) || 0) > 0;
}
