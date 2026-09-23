"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_MANAGE_DAILY_LEASE_MS,
  AUTO_MANAGE_DAILY_RETRY_DELAYS_MS,
  AUTO_MANAGE_DAILY_MAX_ATTEMPTS,
  AUTO_MANAGE_DAILY_OUTCOME,
  buildAutoManageDailyAvailabilityFilter,
  getNextAutoManageDailyAttemptCount,
  buildAutoManageDailyClaimUpdate,
  ownsAutoManageDailyLease,
  resetAutoManageDailyState,
  applyAutoManageDailyReportState,
} = require("../bot/services/auto-manage/runtime/support/daily-state");

const TARGET_DAY = "2026-07-13";
const NOW_MS = Date.parse("2026-07-14T00:05:00.000Z");

test("daily availability is outcome-driven and does not depend on raid-status activity", () => {
  const filter = buildAutoManageDailyAvailabilityFilter(
    { targetDayKey: TARGET_DAY },
    NOW_MS
  );

  assert.deepEqual(filter.lastAutoManageDailyFinishedDayKey, { $ne: TARGET_DAY });
  assert.equal(JSON.stringify(filter).includes("lastRaidStatusOpenedDayKey"), false);
  assert.equal(JSON.stringify(filter).includes("autoManageDailyLeaseDayKey"), false);
});

test("daily claim increments attempts per target day and owns a bounded lease", () => {
  assert.equal(getNextAutoManageDailyAttemptCount({}, TARGET_DAY), 1);
  assert.equal(
    getNextAutoManageDailyAttemptCount(
      {
        lastAutoManageDailyAttemptDayKey: TARGET_DAY,
        autoManageDailyAttemptCount: 2,
      },
      TARGET_DAY
    ),
    3
  );
  assert.equal(
    getNextAutoManageDailyAttemptCount(
      {
        lastAutoManageDailyAttemptDayKey: "2026-07-12",
        autoManageDailyAttemptCount: 99,
      },
      TARGET_DAY
    ),
    1
  );

  const update = buildAutoManageDailyClaimUpdate({
    targetDayKey: TARGET_DAY,
    attemptCount: 2,
    nowMs: NOW_MS,
  });
  assert.deepEqual(update, {
    $inc: { __v: 1 },
    $set: {
      lastAutoManageDailyAttemptDayKey: TARGET_DAY,
      autoManageDailyAttemptCount: 2,
      autoManageDailyNextAttemptAt: null,
      autoManageDailyLeaseDayKey: TARGET_DAY,
      autoManageDailyLeaseUntil: NOW_MS + AUTO_MANAGE_DAILY_LEASE_MS,
      autoManageDailyLeaseToken: update.$set.autoManageDailyLeaseToken,
      lastAutoManageDailyOutcome: AUTO_MANAGE_DAILY_OUTCOME.inFlight,
    },
  });
  assert.equal(
    ownsAutoManageDailyLease(
      {
        autoManageDailyLeaseDayKey: TARGET_DAY,
        autoManageDailyAttemptCount: 2,
      },
      TARGET_DAY,
      2
    ),
    true
  );
  assert.equal(
    ownsAutoManageDailyLease(
      {
        autoManageDailyLeaseDayKey: TARGET_DAY,
        autoManageDailyAttemptCount: 3,
      },
      TARGET_DAY,
      2
    ),
    false
  );
});

test("reset and re-enable cannot give an old worker ownership of a new same-day attempt", () => {
  const first = buildAutoManageDailyClaimUpdate({ targetDayKey: TARGET_DAY, attemptCount: 1, nowMs: NOW_MS });
  const second = buildAutoManageDailyClaimUpdate({ targetDayKey: TARGET_DAY, attemptCount: 1, nowMs: NOW_MS });
  const doc = { ...first.$set };
  const oldToken = first.$set.autoManageDailyLeaseToken;
  assert.equal(ownsAutoManageDailyLease(doc, TARGET_DAY, 1, oldToken), true);
  resetAutoManageDailyState(doc);
  assert.equal(ownsAutoManageDailyLease(doc, TARGET_DAY, 1, oldToken), false);
  Object.assign(doc, second.$set);
  assert.notEqual(second.$set.autoManageDailyLeaseToken, oldToken);
  assert.equal(ownsAutoManageDailyLease(doc, TARGET_DAY, 1, oldToken), false);
  assert.equal(ownsAutoManageDailyLease(doc, TARGET_DAY, 1, second.$set.autoManageDailyLeaseToken), true);
});

test("successful daily report finishes the target day and clears retry state", () => {
  const doc = {
    autoManageDailyLeaseDayKey: TARGET_DAY,
    autoManageDailyLeaseUntil: NOW_MS + 1000,
    autoManageDailyNextAttemptAt: NOW_MS + 2000,
  };
  const transition = applyAutoManageDailyReportState({
    userDoc: doc,
    report: { perChar: [{ error: null, applied: [] }] },
    targetDayKey: TARGET_DAY,
    attemptCount: 1,
    nowMs: NOW_MS,
  });

  assert.deepEqual(transition, {
    bucket: "synced",
    outcome: AUTO_MANAGE_DAILY_OUTCOME.success,
    nextAttemptAt: null,
  });
  assert.equal(doc.lastAutoManageDailyFinishedDayKey, TARGET_DAY);
  assert.equal(doc.lastAutoManageDailyOutcome, AUTO_MANAGE_DAILY_OUTCOME.success);
  assert.equal(doc.autoManageDailyNextAttemptAt, null);
  assert.equal(doc.autoManageDailyLeaseDayKey, "");
  assert.equal(doc.autoManageDailyLeaseUntil, null);
});

test("all-private and no-actionable reports settle without retrying", () => {
  for (const { report, expectedOutcome } of [
    {
      report: {
        perChar: [
          { error: "Logs not enabled" },
          { error: "Logs not enabled" },
        ],
      },
      expectedOutcome: AUTO_MANAGE_DAILY_OUTCOME.allPrivate,
    },
    {
      report: { perChar: [] },
      expectedOutcome: AUTO_MANAGE_DAILY_OUTCOME.noActionable,
    },
  ]) {
    const doc = {
      autoManageDailyLeaseDayKey: TARGET_DAY,
      autoManageDailyLeaseUntil: NOW_MS + 1000,
    };
    const transition = applyAutoManageDailyReportState({
      userDoc: doc,
      report,
      targetDayKey: TARGET_DAY,
      attemptCount: 1,
      nowMs: NOW_MS,
    });

    assert.equal(transition.bucket, "settled");
    assert.equal(transition.outcome, expectedOutcome);
    assert.equal(doc.lastAutoManageDailyFinishedDayKey, TARGET_DAY);
    assert.equal(doc.autoManageDailyNextAttemptAt, null);
  }
});

test("a character Bible does not know settles the day instead of retrying", () => {
  const missing = 'lostark.bible has no character "Kanna"';
  for (const { perChar, bucket, outcome } of [
    {
      perChar: [{ error: null, applied: [] }, { error: missing }],
      bucket: "synced",
      outcome: AUTO_MANAGE_DAILY_OUTCOME.success,
    },
    {
      perChar: [{ error: missing }],
      bucket: "settled",
      outcome: AUTO_MANAGE_DAILY_OUTCOME.noActionable,
    },
    {
      // All-private stays strict: this roster is not only a Public Log issue.
      perChar: [{ error: missing }, { error: "Logs not enabled" }],
      bucket: "settled",
      outcome: AUTO_MANAGE_DAILY_OUTCOME.noActionable,
    },
    {
      perChar: [{ error: missing }, { error: "LostArk Bible HTTP 429" }],
      bucket: "retry-scheduled",
      outcome: AUTO_MANAGE_DAILY_OUTCOME.retryScheduled,
    },
  ]) {
    const transition = applyAutoManageDailyReportState({
      userDoc: { autoManageDailyLeaseDayKey: TARGET_DAY },
      report: { perChar },
      targetDayKey: TARGET_DAY,
      attemptCount: 1,
      nowMs: NOW_MS,
    });

    assert.equal(transition.bucket, bucket, JSON.stringify(perChar));
    assert.equal(transition.outcome, outcome, JSON.stringify(perChar));
  }
});

test("a partial daily success still retries when another character hit a transient error", () => {
  const doc = {
    autoManageDailyLeaseDayKey: TARGET_DAY,
    autoManageDailyLeaseUntil: NOW_MS + 1000,
  };
  const transition = applyAutoManageDailyReportState({
    userDoc: doc,
    report: {
      perChar: [
        { error: null, applied: [] },
        { error: "LostArk Bible HTTP 429", applied: [] },
      ],
    },
    targetDayKey: TARGET_DAY,
    attemptCount: 1,
    nowMs: NOW_MS,
  });

  assert.equal(transition.bucket, "retry-scheduled");
  assert.equal(transition.outcome, AUTO_MANAGE_DAILY_OUTCOME.retryScheduled);
  assert.equal(
    doc.autoManageDailyNextAttemptAt,
    NOW_MS + AUTO_MANAGE_DAILY_RETRY_DELAYS_MS[0]
  );
});

test("transient failures back off and finish only after bounded exhaustion", () => {
  assert.deepEqual(AUTO_MANAGE_DAILY_RETRY_DELAYS_MS, [
    30 * 60 * 1000,
    60 * 60 * 1000,
    2 * 60 * 60 * 1000,
  ]);
  assert.equal(AUTO_MANAGE_DAILY_MAX_ATTEMPTS, 4);

  for (let attemptCount = 1; attemptCount < AUTO_MANAGE_DAILY_MAX_ATTEMPTS; attemptCount += 1) {
    const doc = {
      autoManageDailyLeaseDayKey: TARGET_DAY,
      autoManageDailyLeaseUntil: NOW_MS + 1000,
    };
    const transition = applyAutoManageDailyReportState({
      userDoc: doc,
      report: { perChar: [{ error: "HTTP 503" }] },
      targetDayKey: TARGET_DAY,
      attemptCount,
      nowMs: NOW_MS,
    });

    assert.equal(transition.bucket, "retry-scheduled");
    assert.equal(
      transition.nextAttemptAt,
      NOW_MS + AUTO_MANAGE_DAILY_RETRY_DELAYS_MS[attemptCount - 1]
    );
    assert.equal(doc.lastAutoManageDailyFinishedDayKey, undefined);
    assert.equal(doc.autoManageDailyLeaseDayKey, "");
  }

  const exhaustedDoc = {
    autoManageDailyLeaseDayKey: TARGET_DAY,
    autoManageDailyLeaseUntil: NOW_MS + 1000,
  };
  const exhausted = applyAutoManageDailyReportState({
    userDoc: exhaustedDoc,
    report: { perChar: [{ error: "HTTP 503" }] },
    targetDayKey: TARGET_DAY,
    attemptCount: AUTO_MANAGE_DAILY_MAX_ATTEMPTS,
    nowMs: NOW_MS,
  });

  assert.equal(exhausted.bucket, "retry-exhausted");
  assert.equal(
    exhaustedDoc.lastAutoManageDailyOutcome,
    AUTO_MANAGE_DAILY_OUTCOME.retryExhausted
  );
  assert.equal(exhaustedDoc.lastAutoManageDailyFinishedDayKey, TARGET_DAY);
  assert.equal(exhaustedDoc.autoManageDailyNextAttemptAt, null);
});
