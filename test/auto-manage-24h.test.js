"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getAutoManageDailyContext } = require("../bot/services/auto-manage/runtime/support/daily-backfill");
const {
  applyAutoManageDailyReportState,
  buildAutoManageDailyAvailabilityFilter,
  getNextAutoManageDailyAttemptCount,
} = require("../bot/services/auto-manage/runtime/support/daily-state");

// Evaluate the Mongo operators used by the availability filter against boundary fixtures.
function matches(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$and") return condition.every(part => matches(doc, part));
    if (key === "$or") return condition.some(part => matches(doc, part));
    const value = key.split(".").reduce((current, part) => current?.[part], doc);
    if (condition === null) return value == null;
    if (typeof condition !== "object") return value === condition;
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === "$exists") return (value !== undefined) === expected;
      if (operator === "$ne") return value !== expected;
      if (operator === "$lte") return value != null && value <= expected;
      throw Error(`Unsupported fixture operator ${operator}`);
    });
  });
}

const now = Date.parse("2026-09-05T17:05:00Z");
const context = getAutoManageDailyContext(new Date(now));
const candidate = {};

test("daily background opens at each VN calendar boundary regardless of recent sync timestamps", () => {
  const query = buildAutoManageDailyAvailabilityFilter(context, now);
  assert.equal(matches(candidate, query), true, "legacy users without timestamps are eligible");
  assert.equal(matches({ ...candidate, lastAutoManageDailyFinishedAt: now - 10 * 60_000 }, query), true);
  assert.equal(matches({ ...candidate, lastAutoManageSyncAt: now - 10 * 60_000 }, query), true);
  assert.equal(matches({ ...candidate, lastAutoManageDailyFinishedDayKey: "2026-09-04" }, query), true);
  assert.equal(matches({ ...candidate, lastAutoManageDailyFinishedDayKey: context.targetDayKey }, query), false);
  assert.equal(matches({ ...candidate, autoManageDailyLeaseUntil: now + 1 }, query), false);
});

test("retry deadline survives VN midnight while the new target gets a fresh attempt budget", () => {
  const retry = { ...candidate, lastAutoManageDailyAttemptDayKey: "2026-09-04", lastAutoManageDailyOutcome: "retry-scheduled", autoManageDailyAttemptCount: 3, autoManageDailyNextAttemptAt: now + 1 };
  assert.equal(matches(retry, buildAutoManageDailyAvailabilityFilter(context, now)), false);
  assert.equal(matches(retry, buildAutoManageDailyAvailabilityFilter(context, now + 1)), true);
  assert.equal(getNextAutoManageDailyAttemptCount(retry, context.targetDayKey), 1);
});

test("every terminal daily outcome settles only its target calendar day", () => {
  for (const report of [{ perChar: [{ applied: [] }] }, { perChar: [] }, { perChar: [{ error: "Logs not enabled" }] }, { perChar: [{ error: "HTTP 503" }] }]) {
    const doc = {};
    applyAutoManageDailyReportState({ userDoc: doc, report, targetDayKey: context.targetDayKey, attemptCount: 4, nowMs: now });
    assert.equal(doc.lastAutoManageDailyFinishedAt, now);
    assert.equal(doc.lastAutoManageDailyFinishedDayKey, context.targetDayKey);
    assert.equal(matches({ ...candidate, ...doc }, buildAutoManageDailyAvailabilityFilter(context, now)), false);
    assert.equal(matches({ ...candidate, ...doc }, buildAutoManageDailyAvailabilityFilter({ targetDayKey: "2026-09-06" }, now)), true);
  }
});
