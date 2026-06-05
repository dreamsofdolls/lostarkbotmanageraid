"use strict";

function finiteNumbers(values, { includeZero = true } = {}) {
  return (values || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && (includeZero ? value >= 0 : value > 0));
}

function average(values) {
  const nums = finiteNumbers(values);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function stddev(values) {
  const nums = finiteNumbers(values);
  if (nums.length <= 1) return 0;
  const avg = average(nums);
  const variance = nums.reduce((sum, value) => sum + (value - avg) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function consistencyScoreFromValues(values, { minSamples = 3, includeZero = true } = {}) {
  const nums = finiteNumbers(values, { includeZero });
  if (nums.length < minSamples) return null;
  const avg = average(nums);
  if (avg <= 0) return null;
  return clampScore(100 - (stddev(nums) / avg) * 100);
}

function weightedScore(parts, fallback = 50) {
  let total = 0;
  let weight = 0;
  for (const part of parts) {
    if (!Number.isFinite(part?.score)) continue;
    const partWeight = Number(part.weight) || 0;
    if (partWeight <= 0) continue;
    total += part.score * partWeight;
    weight += partWeight;
  }
  return Math.round((weight ? total / weight : fallback) * 10) / 10;
}

function supportUptimePercent(row) {
  const ap = Number(row?.supportAp) || 0;
  const brand = Number(row?.supportBrand) || 0;
  const identity = Number(row?.supportIdentity) || 0;
  const hyper = Number(row?.supportHyper) || 0;
  return (ap * 0.3 + brand * 0.3 + identity * 0.25 + hyper * 0.15) * 100;
}

export function computeProfileConsistency(rows, role = "dps") {
  const profileRows = Array.isArray(rows) ? rows : [];
  const rawDpsScore = consistencyScoreFromValues(profileRows.map((row) => row.dps), { includeZero: false });

  if (role === "support") {
    const rdpsRows = profileRows.filter((row) => row?.rdpsValid === true);
    return weightedScore([
      {
        score: consistencyScoreFromValues(rdpsRows.map((row) => row.supporterPercent), { includeZero: true }),
        weight: 0.5,
      },
      {
        score: consistencyScoreFromValues(profileRows.map((row) => row.protectionPerMinute), { includeZero: true }),
        weight: 0.25,
      },
      {
        score: consistencyScoreFromValues(profileRows.map(supportUptimePercent), { includeZero: true }),
        weight: 0.25,
      },
      { score: rawDpsScore, weight: 0.05 },
    ], rawDpsScore ?? 50);
  }

  return weightedScore([
    {
      score: consistencyScoreFromValues(profileRows.map((row) => row.damageShare), { includeZero: true }),
      weight: 0.45,
    },
    {
      score: consistencyScoreFromValues(profileRows.map((row) => row.topDamageProximity), { includeZero: true }),
      weight: 0.4,
    },
    { score: rawDpsScore, weight: 0.15 },
  ], rawDpsScore ?? 50);
}

export const __test = {
  consistencyScoreFromValues,
};
