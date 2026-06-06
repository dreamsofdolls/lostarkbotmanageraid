"use strict";

const RESULT_CLASSIFIERS = Object.freeze([
  {
    matches: (result) => !result || typeof result !== "object",
    append: ({ bucket, rejected }) => rejected.push({
      charName: bucket.charName,
      reason: "write_error",
      error: "empty apply result",
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
    }),
  },
  {
    matches: (result) => result.syncDisabled,
    append: ({ bucket, effectiveGates, rejected }) => rejected.push({
      charName: bucket.charName,
      reason: "local_sync_disabled",
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
    }),
  },
  {
    matches: (result) => result.noRoster,
    append: ({ bucket, effectiveGates, rejected }) => rejected.push({
      charName: bucket.charName,
      reason: "no_roster",
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
    }),
  },
  {
    matches: (result) => !result.matched,
    append: ({ bucket, effectiveGates, rejected }) => rejected.push({
      charName: bucket.charName,
      reason: "char_not_in_roster",
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
    }),
  },
  {
    matches: (result) => result.ineligibleItemLevel,
    append: ({ result, bucket, effectiveGates, rejected }) => rejected.push({
      charName: bucket.charName,
      reason: "ilvl_too_low",
      ineligibleItemLevel: result.ineligibleItemLevel,
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
    }),
  },
  {
    matches: (result) => result.updated,
    append: ({ result, bucket, effectiveGates, applied }) => applied.push({
      charName: result.displayName || bucket.charName,
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
      modeResetCount: result.modeResetCount || 0,
    }),
  },
]);

function appendApplyResult(result, bucket, effectiveGates, lists) {
  const classifier = RESULT_CLASSIFIERS.find((entry) => entry.matches(result));
  if (classifier) {
    classifier.append({ result, bucket, effectiveGates, ...lists });
    return;
  }

  lists.skipped.push({
    charName: result.displayName || bucket.charName,
    raidKey: bucket.raidKey,
    modeKey: bucket.modeKey,
    gates: effectiveGates,
    reason: "already_complete",
  });
}

function appendPreflightDecision(preflight, bucket, effectiveGates, { skipped, rejected }) {
  if (preflight.action === "reject") {
    rejected.push({
      charName: bucket.charName,
      reason: preflight.reason,
      ineligibleItemLevel: preflight.ineligibleItemLevel,
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
    });
    return true;
  }

  if (preflight.action === "skip") {
    skipped.push({
      charName: preflight.displayName || bucket.charName,
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      gates: effectiveGates,
      reason: preflight.reason,
    });
    return true;
  }

  return false;
}

function writeErrorEntry(bucket, err) {
  return {
    charName: bucket.charName,
    reason: "write_error",
    error: err?.message || String(err),
    raidKey: bucket.raidKey,
    modeKey: bucket.modeKey,
  };
}

module.exports = {
  appendApplyResult,
  appendPreflightDecision,
  writeErrorEntry,
};
