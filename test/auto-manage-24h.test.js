"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAutoManageDailyCandidateQuery } = require("../bot/services/raid/schedulers/auto-manage-daily-scheduler");
const { getAutoManageDailyContext } = require("../bot/services/auto-manage/runtime/support/daily-backfill");
const { applyAutoManageDailyReportState, getNextAutoManageDailyAttemptCount } = require("../bot/services/auto-manage/runtime/support/daily-state");

// Evaluate the Mongo operators used by the candidate query against boundary fixtures.
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

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-05T17:05:00Z");
const context = getAutoManageDailyContext(new Date(now));
const candidate = { autoManageEnabled: true, accounts: [{}] };

test("daily background waits 24 hours after a settled run or a successful interactive sync", () => {
  const query = buildAutoManageDailyCandidateQuery(context, now);
  assert.equal(matches(candidate, query), true, "legacy users without timestamps are eligible");
  for (const field of ["lastAutoManageDailyFinishedAt", "lastAutoManageSyncAt"]) {
    assert.equal(matches({ ...candidate, [field]: now - 10 * 60_000 }, query), false, "midnight does not make recent data stale");
    assert.equal(matches({ ...candidate, [field]: now - DAY + 1 }, query), false);
    assert.equal(matches({ ...candidate, [field]: now - DAY }, query), true);
    assert.equal(matches({ ...candidate, [field]: null }, query), true);
  }
  assert.equal(matches({ ...candidate, autoManageEnabled: false }, query), false);
  assert.equal(matches({ ...candidate, localSyncEnabled: true }, query), false);
  assert.equal(matches({ ...candidate, accounts: [] }, query), false);
  assert.equal(matches({ ...candidate, autoManageDailyLeaseUntil: now + 1 }, query), false);
});

test("background retry deadlines and attempt limits survive a VN midnight rollover", () => {
  const retry = { ...candidate, lastAutoManageDailyAttemptDayKey: "2026-09-04", lastAutoManageDailyOutcome: "retry-scheduled", autoManageDailyAttemptCount: 3, autoManageDailyNextAttemptAt: now + 1 };
  assert.equal(matches(retry, buildAutoManageDailyCandidateQuery(context, now)), false);
  assert.equal(matches(retry, buildAutoManageDailyCandidateQuery(context, now + 1)), true);
  assert.equal(getNextAutoManageDailyAttemptCount(retry, context.targetDayKey), 4);
});

test("every terminal daily outcome starts the 24-hour interval, including exhausted retries", () => {
  for (const report of [{ perChar: [{ applied: [] }] }, { perChar: [] }, { perChar: [{ error: "private" }] }, { perChar: [{ error: "HTTP 503" }] }]) {
    const doc = {};
    applyAutoManageDailyReportState({ userDoc: doc, report, isPublicLogDisabledError: error => error === "private", targetDayKey: context.targetDayKey, attemptCount: 4, nowMs: now });
    assert.equal(doc.lastAutoManageDailyFinishedAt, now);
  }
});
