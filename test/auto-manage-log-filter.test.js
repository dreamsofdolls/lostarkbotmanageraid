"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { filterLogsForCharacter } = require("../bot/services/auto-manage/runtime/support/helpers");
const normalizeName = (value) => String(value || "").trim().toLowerCase();

test("log filtering preserves order and raw mismatch names while excluding unnamed rows", () => {
  const logs = [
    { name: " Alice ", id: 1 }, { name: "Bob" }, null,
    { name: "ALICE", id: 2 }, { name: "Bob" }, { name: "bob" }, { name: " " },
  ];
  const result = filterLogsForCharacter(logs, "alice", normalizeName);
  assert.deepEqual(result, {
    logs: [logs[0], logs[3]], mismatchedNames: ["Bob", "bob"], hadNamedLogs: true,
  });
  assert.strictEqual(result.logs[0], logs[0]);
  assert.equal(logs.length, 7);
});

test("log filtering retains legacy unnamed logs and empty-name pass-through", () => {
  const unnamed = [{ id: 1 }, null, { name: "" }];
  const named = [{ name: "Bob" }];
  assert.strictEqual(filterLogsForCharacter(unnamed, "Alice", normalizeName).logs, unnamed);
  assert.deepEqual(filterLogsForCharacter(named, "", normalizeName), {
    logs: named, mismatchedNames: [], hadNamedLogs: false,
  });
  assert.deepEqual(filterLogsForCharacter(null, "Alice", normalizeName), {
    logs: [], mismatchedNames: [], hadNamedLogs: false,
  });
  assert.deepEqual(filterLogsForCharacter(named, "Alice", normalizeName), {
    logs: [], mismatchedNames: ["Bob"], hadNamedLogs: true,
  });
});

test("log filtering normalizes each present row once", () => {
  const logs = new Array(4);
  logs[0] = { name: "Alice" };
  logs[2] = { name: "Bob" };
  logs[3] = { name: "" };
  const calls = [];
  const result = filterLogsForCharacter(logs, "Alice", (value) => {
    calls.push(value);
    return normalizeName(value);
  });
  assert.deepEqual(result.logs, [logs[0]]);
  assert.deepEqual(calls, ["Alice", "Alice", "Bob", ""]);
});
