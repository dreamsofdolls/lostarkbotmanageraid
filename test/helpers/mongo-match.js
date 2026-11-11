"use strict";

// Whether a plain document matches a Mongo filter, for the operators the
// bot's queries use: equality, `$ne`, `$exists` and `$or`, on dotted paths.
// `$ne` follows Mongo: a missing field matches unless the value compared is null.
const OPERATORS = {
  $ne: (value, expected) => (expected === null ? value != null : value !== expected),
  $exists: (value, expected) => (value !== undefined) === expected,
};

function docMatchesQuery(doc, query) {
  return Object.entries(query).every(([path, condition]) => (path === "$or"
    ? condition.some((sub) => docMatchesQuery(doc, sub))
    : fieldMatches(readPath(doc, path), condition)));
}

function readPath(doc, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function fieldMatches(value, condition) {
  const operator = condition && typeof condition === "object"
    ? Object.keys(condition).find((key) => Object.hasOwn(OPERATORS, key))
    : undefined;
  return operator ? OPERATORS[operator](value, condition[operator]) : value === condition;
}

module.exports = { docMatchesQuery };
