"use strict";

const {
  finiteNumber,
} = require("../../bible/log-utils");

function round1(value) {
  return Math.round((finiteNumber(value) || 0) * 10) / 10;
}

function round2(value) {
  return Math.round((finiteNumber(value) || 0) * 100) / 100;
}

function clampScore(value) {
  const n = finiteNumber(value, 0);
  return Math.max(0, Math.min(100, n));
}

function normalizePercentileValue(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text.endsWith("%") ? text.slice(0, -1) : text);
    if (!Number.isFinite(parsed)) return null;
    return normalizePercentileValue(parsed);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return clampScore(n * 100);
  return clampScore(n);
}

function average(values) {
  const nums = (values || []).map((v) => Number(v)).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function percentile(values, p) {
  const nums = (values || []).map((v) => Number(v)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = (nums.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  const weight = idx - lo;
  return nums[lo] * (1 - weight) + nums[hi] * weight;
}

function minPositive(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : null;
}

function maxPositive(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

function consistencyScore(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length <= 1) return nums.length ? 65 : 0;
  const mean = average(nums);
  if (mean <= 0) return 0;
  const variance = nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
  const cv = Math.sqrt(variance) / mean;
  return clampScore(100 - cv * 140);
}

module.exports = {
  average,
  clampScore,
  consistencyScore,
  maxPositive,
  minPositive,
  normalizePercentileValue,
  percentile,
  round1,
  round2,
};
