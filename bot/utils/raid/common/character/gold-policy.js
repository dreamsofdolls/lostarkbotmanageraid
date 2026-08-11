"use strict";

/**
 * Resolve the canonical persisted gold override while preserving support for
 * the legacy boolean fields that predate `goldOverride`.
 *
 * Keep this helper below character.js in the dependency graph: both assigned-
 * raid normalization and higher-level status projections need the same rule.
 */
function getGoldOverride(source) {
  if (source?.goldOverride === "include" || source?.goldForced === true) return "include";
  if (source?.goldOverride === "exclude" || source?.goldDisabled === true) return "exclude";
  return null;
}

module.exports = {
  getGoldOverride,
};
