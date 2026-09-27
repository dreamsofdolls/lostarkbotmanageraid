"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLatestRaidLogLookup, selectLatestCharacterLog } = require("../bot/services/raid-log/latest");
const { parseRaidLogSource } = require("../bot/services/raid-log/source");
const { raidLogErrorCode } = require("../bot/services/raid-log/errors");
const { createBibleClient } = require("../bot/services/auto-manage/bible/client");
const { createBibleCharacterNotFoundError } = require("../bot/services/auto-manage/bible/error-kinds");

test("source requires exactly one valid name or public log URL, preserving Unicode accents", () => {
  assert.deepEqual(parseRaidLogSource({ character: "  SátuRn  " }), { character: "SátuRn" });
  assert.deepEqual(parseRaidLogSource({ url: "https://lostark.bible/logs/ABC/" }), { url: "https://lostark.bible/logs/ABC" });
  for (const input of [{}, { character: "  " }, { character: "Saturn", url: "https://lostark.bible/logs/ABC" }]) {
    assert.throws(() => parseRaidLogSource(input), { code: "invalid_source" });
  }
  for (const character of ["../logs/a", "two names", "https://example.com", "a".repeat(65), "name\nother"]) {
    assert.throws(() => parseRaidLogSource({ character }), { code: "invalid_character" });
  }
});

test("latest selection uses timestamp, ignores other characters and does not mutate API order", () => {
  const logs = [
    { id: "older", name: "Saturnxd", timestamp: 100 },
    { id: "wrong-character", name: "Someoneelse", timestamp: 500 },
    { id: "latest", name: "SATURNXD", timestamp: "200", isBus: true },
  ];
  const selected = selectLatestCharacterLog(logs, "Saturnxd");
  assert.deepEqual(selected, { id: "latest", url: "https://lostark.bible/logs/latest", character: "Saturnxd", region: "NA", timestamp: 200 });
  assert.equal(logs[0].id, "older");
  // Distinct accented names must never be treated as the same character.
  assert.throws(() => selectLatestCharacterLog([{ id: "x", name: "Saturn", timestamp: 10 }], "Sáturn"), { code: "character_mismatch" });
  assert.throws(() => selectLatestCharacterLog([{ id: "x", timestamp: 10 }], "Saturn"), { code: "character_mismatch" });
});

test("empty or malformed logs fail instead of silently selecting an older capture", () => {
  assert.throws(() => selectLatestCharacterLog([], "Saturnxd"), { code: "no_logs" });
  assert.throws(() => selectLatestCharacterLog({}, "Saturnxd"), { code: "unavailable" });
  for (const invalid of [
    { id: "bad", timestamp: null }, { id: "bad", timestamp: "oops" },
    { id: "../other", timestamp: 300 }, { timestamp: 300 },
  ]) {
    assert.throws(() => selectLatestCharacterLog([
      { name: "Saturnxd", id: "old", timestamp: 100 }, { name: "Saturnxd", ...invalid },
    ], "Saturnxd"), { code: "unavailable" });
  }
});

function fixture({ profile, logs, metaError, logsError } = {}) {
  const calls = [];
  const lookup = createLatestRaidLogLookup({
    client: {
      fetchBibleCharacterProfileWithLimiter: async name => {
        calls.push(["profile", name]);
        if (metaError) throw metaError;
        return { sn: "serial-1", cid: 123, rid: 456, name: "Saturnxd", className: "Deathblade", ...profile };
      },
      fetchBibleLogsWithLimiter: async args => {
        calls.push(["logs", args]);
        if (logsError) throw logsError;
        return logs ?? [{ id: "ABC", name: "Saturnxd", timestamp: 100 }];
      },
    },
  });
  return { calls, lookup };
}

test("lookup resolves exact name/class and requests only page 1 with fresh Bible IDs", async () => {
  const { lookup, calls } = fixture();
  const selected = await lookup("saturnxd");
  assert.equal(selected.character, "Saturnxd");
  assert.equal(selected.url, "https://lostark.bible/logs/ABC");
  assert.deepEqual(calls, [
    ["profile", "saturnxd"],
    ["logs", { serial: "serial-1", cid: 123, rid: 456, className: "Deathblade", page: 1 }],
  ]);
});

test("lookup rejects profile identity mismatch before fetching logs", async () => {
  const { lookup, calls } = fixture({ profile: { name: "Other" } });
  await assert.rejects(lookup("Saturnxd"), { code: "character_mismatch" });
  assert.equal(calls.length, 1);
});

test("central error mapping distinguishes unknown names, private logs, blocked access, timeout and backoff", async () => {
  const hasCode = expected => error => raidLogErrorCode(error) === expected;
  const unknown = fixture({ metaError: createBibleCharacterNotFoundError("Ratelimit") });
  await assert.rejects(unknown.lookup("Ratelimit"), hasCode("character_not_found"));
  assert.equal(unknown.calls.length, 1);
  await assert.rejects(fixture({ logs: [] }).lookup("Saturnxd"), { code: "no_logs" });
  const privateError = Object.assign(new Error('Bible logs API returned HTTP 403 - {"error":"Logs not enabled"}'), { status: 403 });
  await assert.rejects(fixture({ logsError: privateError }).lookup("Saturnxd"), hasCode("logs_private"));
  await assert.rejects(fixture({ logsError: Object.assign(new Error("Blocked"), { status: 403 }) }).lookup("Saturnxd"), hasCode("unavailable"));
  await assert.rejects(fixture({ metaError: Object.assign(new Error("Timed out"), { name: "TimeoutError" }) }).lookup("Saturnxd"), hasCode("timeout"));
  const backoff = Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 60_000 });
  await assert.rejects(fixture({ logsError: backoff }).lookup("Saturnxd"), error => error === backoff);
  assert.equal(raidLogErrorCode(backoff), "rate_limited");
  assert.equal(raidLogErrorCode(new Error("Internal path")), "failed");
});

test("real Bible client resolves name/class and latest log with exactly two limited HTTP requests", async () => {
  const calls = [];
  let limitedCalls = 0;
  const html = '<title>Saturnxd (NA) | lostark.bible</title><script>data:{header:{id:123,sn:"serial-1",rid:456,combatPowerHistory:[{score:8000}],class:"blade"},redirectedFrom:null},roster:[{name:"Other",class:"bard"}]</script>';
  const client = createBibleClient({
    bibleLimiter: { run: fn => { limitedCalls++; return fn(); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => html, json: async () => [{ id: "ABC", name: "Saturnxd", timestamp: 100 }] };
    },
  });
  const result = await createLatestRaidLogLookup({ client })("saturnxd");
  assert.equal(result.character, "Saturnxd");
  assert.equal(calls.length, 2);
  assert.equal(limitedCalls, 2);
  assert.equal(calls[0].url, "https://lostark.bible/character/NA/saturnxd/roster");
  const payload = JSON.parse(calls[1].options.body);
  assert.deepEqual(payload, { region: "NA", characterSerial: "serial-1", className: "Deathblade", cid: 123, rid: 456, page: 1 });
});
