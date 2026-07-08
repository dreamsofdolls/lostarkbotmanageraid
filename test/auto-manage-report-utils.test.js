"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAutoManageEntries,
  hasSuccessfulAutoManageReport,
  getAppliedAutoManageEntries,
  hasAppliedAutoManageDelta,
  countAppliedAutoManageGates,
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
} = require("../bot/services/auto-manage/reports/utils");

test("auto-manage report helpers normalize missing and malformed report entries", () => {
  assert.deepEqual(getAutoManageEntries(null), []);
  assert.equal(hasSuccessfulAutoManageReport({ perChar: [{ error: "private" }] }), false);
  assert.equal(hasSuccessfulAutoManageReport({ perChar: [{ error: null }] }), true);
});

test("auto-manage report helpers count applied gate deltas", () => {
  const report = {
    perChar: [
      { applied: ["akkan:g1", "akkan:g2"] },
      { applied: [] },
      { error: "private", applied: ["ignored:g1"] },
      { applied: ["thaemine:g1"] },
    ],
  };

  assert.deepEqual(getAppliedAutoManageEntries(report).map((entry) => entry.applied), [
    ["akkan:g1", "akkan:g2"],
    ["ignored:g1"],
    ["thaemine:g1"],
  ]);
  assert.equal(hasAppliedAutoManageDelta(report), true);
  assert.equal(countAppliedAutoManageGates(report), 4);
});

test("stampAutoManageAttemptFromReport stamps sync only when at least one char succeeded", () => {
  const failedDoc = {};
  assert.equal(
    stampAutoManageAttemptFromReport(failedDoc, { perChar: [{ error: "private" }] }, 123),
    false
  );
  assert.equal(failedDoc.lastAutoManageAttemptAt, 123);
  assert.equal(failedDoc.lastAutoManageSyncAt, undefined);

  const syncedDoc = {};
  assert.equal(
    stampAutoManageAttemptFromReport(syncedDoc, { perChar: [{ error: null }] }, 456),
    true
  );
  assert.equal(syncedDoc.lastAutoManageAttemptAt, 456);
  assert.equal(syncedDoc.lastAutoManageSyncAt, 456);
});

test("toPlainUserDoc unwraps mongoose-like docs and leaves plain docs untouched", () => {
  const plain = { discordId: "plain" };
  assert.equal(toPlainUserDoc(plain), plain);
  assert.deepEqual(toPlainUserDoc({ toObject: () => ({ discordId: "mongoose" }) }), {
    discordId: "mongoose",
  });
  assert.equal(toPlainUserDoc(null), null);
});
