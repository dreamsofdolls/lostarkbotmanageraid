"use strict";

// Whether a plain document matches a Mongo filter, for the operators the
// scheduler queries use: equality, `$ne` and `$or`, on dotted paths. `$ne`
// follows Mongo: a missing field matches unless the value compared is null.
function docMatchesQuery(doc, query) {
  return Object.entries(query).every(([path, condition]) => (path === "$or"
    ? condition.some((sub) => docMatchesQuery(doc, sub))
    : fieldMatches(readPath(doc, path), condition)));
}

function readPath(doc, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function fieldMatches(value, condition) {
  if (condition && typeof condition === "object" && "$ne" in condition) {
    return condition.$ne === null ? value != null : value !== condition.$ne;
  }
  return value === condition;
}

module.exports = { docMatchesQuery };
