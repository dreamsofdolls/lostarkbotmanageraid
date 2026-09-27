"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatCompact, percentOf, formatPercent, formatShare, formatClock, formatWhen } = require("../bot/services/raid-log/format");
const { parseTier } = require("../bot/services/raid-log/parse-tiers");

test("large numbers keep three significant digits with a unit", () => {
  const cases = [[1060505447, "1.06B"], [385681991, "386M"], [3500, "3.5K"], [35.5e6, "35.5M"], [999.6e6, "1B"],
    [1928393107867, "1.93T"], [12, "12"], [null, "-"], [undefined, "-"]];
  for (const [value, text] of cases) assert.equal(formatCompact(value), text, String(value));
});

test("percentiles floor like Bible's badges; shares keep one decimal; an empty figure reads -", () => {
  // 0.29 * 100 is 28.999999999999996 in floating point; the badge still reads 29.
  assert.deepEqual([0.9925, 0.6074, 0.9931, 0.1613, 0.29, 0.57, null].map(percentOf), [99, 60, 99, 16, 29, 57, null]);
  assert.deepEqual([99, 0, null].map(formatPercent), ["99%", "0%", "-"]);
  assert.deepEqual([0.525898, 0.4722, null, undefined].map(formatShare), ["52.6%", "47.2%", "-", "-"]);
});

test("durations read m:ss and times read dd/MM HH:mm in Vietnam", () => {
  assert.deepEqual([447637, 288001, 0].map(formatClock), ["7:27", "4:48", "0:00"]);
  assert.equal(formatWhen(Date.UTC(2026, 8, 24, 16, 40)), "24/09 23:40");
  assert.equal(formatWhen(Date.UTC(2025, 11, 31, 17, 5)), "01/01 00:05");
});

test("parse tiers follow the badge colours Bible shows", () => {
  const cases = [[100, "🌸"], [99, "🌸"], [97, "🟠"], [91, "🟣"], [76, "🟣"], [63, "🔵"], [37, "🟢"], [16, "⚪"]];
  for (const [percent, emoji] of cases) assert.equal(parseTier(percent).emoji, emoji, String(percent));
  assert.equal(parseTier(99).color, 0xe268a8);
  assert.equal(parseTier(16).color, 0x9d9d9d);
  assert.deepEqual(parseTier(null), { emoji: "⚪", color: null });
});
