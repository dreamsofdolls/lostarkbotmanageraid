"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecentRaidLogs, MAX_RECENT_CHARACTERS } = require("../bot/services/raid-log/recent");
const { silentLog } = require("./helpers/silent-log");

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-27T12:40:00Z");
const bibleRow = (id, name, timestamp, extra = {}) => ({ id, name, boss: "Death Incarnate Kazeros", difficulty: "Hard",
  timestamp, duration: 447637, ...extra });

// `hang` names never answer; `held` names answer when the test releases them.
function fixture({ accounts, rowsByName = {}, errors = {}, hang = [], held = [] } = {}) {
  const calls = [];
  const releases = {};
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    fetchBibleCharacterProfileWithLimiter: async name => {
      calls.push(["profile", name]);
      return { sn: `sn-${name}`, cid: 9, rid: 8, name, className: "Bard" };
    },
    fetchBibleLogsWithLimiter: async args => {
      const name = args.serial.replace(/^sn-/, "");
      calls.push(["logs", name, args]);
      if (hang.includes(name)) return new Promise(() => {});
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise(resolve => (held.includes(name) ? releases[name] = resolve : setImmediate(resolve)));
        if (errors[name]) throw errors[name];
        return rowsByName[name] || [];
      } finally { inFlight -= 1; }
    },
  };
  let now = NOW;
  const warnings = [];
  const recent = createRecentRaidLogs({ client, now: () => now, deadlineMs: 50,
    log: { ...silentLog, warn: message => warnings.push(message) } });
  return { calls, warnings, recent, accounts, advance: ms => { now += ms; }, release: name => releases[name](),
    get maxInFlight() { return maxInFlight; } };
}

const character = (name, extra = {}) => ({ name, class: "Aeromancer", itemLevel: 1760, bibleSerial: `sn-${name}`, bibleCid: 1, bibleRid: 2, ...extra });

test("recent logs use stored Bible ids, ask for a profile only when they are missing, and merge newest first", async () => {
  const f = fixture({ rowsByName: {
    Qiylyn: [bibleRow("q1", "Qiylyn", NOW - 2 * HOUR, { dps: 1e9, percentile: 0.99 })],
    Canameo: [bibleRow("c1", "Canameo", NOW - HOUR, { contributionPercentile: 0.97 }), bibleRow("c2", "Canameo", NOW - 3 * HOUR)],
  } });
  const result = await f.recent.load("owner", [{ accountName: "Main", characters: [
    character("Qiylyn"), { name: "Canameo", class: "Bard", itemLevel: 1755 },
  ] }]);
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)).sort(), [["logs", "Canameo"], ["logs", "Qiylyn"], ["profile", "Canameo"]]);
  assert.deepEqual(f.calls.find(call => call[1] === "Qiylyn")[2], { serial: "sn-Qiylyn", cid: 1, rid: 2, className: "Aeromancer", page: 1 });
  assert.deepEqual(result.entries.map(entry => entry.id), ["c1", "q1", "c2"]);
  assert.deepEqual(result.entries.map(entry => entry.support), [true, false, true]);
  assert.equal(result.entries[1].dps, 1e9);
  assert.deepEqual([result.characters, result.logs, result.capped, result.timedOut, result.private], [2, 3, false, false, []]);
});

test("characters Auto-sync saw private in the last day are skipped; Logs not enabled joins them; partial results are not cached", async () => {
  const f = fixture({ rowsByName: { Qiylyn: [bibleRow("q1", "Qiylyn", NOW)] }, errors: {
    Bori: Object.assign(new Error('Bible logs API returned HTTP 403 - {"error":"Logs not enabled"}'), { status: 403 }),
    Hailua: new Error("socket hang up"),
  } });
  const accounts = [{ accountName: "Main", characters: [
    character("Qiaoli", { publicLogDisabled: true, publicLogDisabledAt: new Date(NOW - HOUR) }),
    character("Qiylyn", { publicLogDisabled: true, publicLogDisabledAt: new Date(NOW - 48 * HOUR) }),
    character("Bori"), character("Hailua"),
  ] }];
  const result = await f.recent.load("owner", accounts);
  assert.ok(!f.calls.some(call => call[1] === "Qiaoli"));
  assert.ok(f.calls.some(call => call[1] === "Qiylyn"));
  assert.deepEqual(result.private, ["Bori", "Qiaoli"]);
  assert.match(f.warnings[0], /recent logs skipped Hailua: socket hang up/);
  await f.recent.load("owner", accounts);
  assert.equal(f.calls.length, 6);
});

test("when Bible fails for every character the load fails with its error, a 429 first, and nothing is kept", async () => {
  const limited = Object.assign(new Error("HTTP 429"), { status: 429 });
  const f = fixture({ errors: { Alpha: new Error("socket hang up"), Bravo: limited } });
  const accounts = [{ accountName: "Main", characters: [character("Alpha", { itemLevel: 1780 }), character("Bravo", { itemLevel: 1770 })] }];
  await assert.rejects(f.recent.load("owner", accounts), error => error === limited);
  await assert.rejects(f.recent.load("owner", accounts), error => error === limited);
  assert.equal(f.calls.length, 4);
  const logsOff = Object.assign(new Error('Bible logs API returned HTTP 403 - {"error":"Logs not enabled"}'), { status: 403 });
  const privateOnly = fixture({ errors: { Alpha: logsOff } });
  const result = await privateOnly.recent.load("owner", [{ accountName: "Main", characters: [character("Alpha")] }]);
  assert.deepEqual([result.entries, result.private], [[], ["Alpha"]]);
});

test("only the 24 highest item levels are read", async () => {
  const characters = Array.from({ length: 30 }, (_, i) => character(`Char${i}`, { itemLevel: 1700 + i }));
  const f = fixture();
  const result = await f.recent.load("owner", [{ accountName: "Main", characters }]);
  assert.equal(MAX_RECENT_CHARACTERS, 24);
  assert.equal(result.capped, true);
  assert.equal(f.calls.length, 24);
  assert.ok(!f.calls.some(call => ["Char0", "Char5"].includes(call[1])));
  assert.equal(f.recent.countCandidates([{ accountName: "Main", characters }]), 24);
});

test("a character that never answers does not hold the rest past the deadline", async () => {
  const f = fixture({ hang: ["Slow"], rowsByName: { Qiylyn: [bibleRow("q1", "Qiylyn", NOW - HOUR)] } });
  const result = await f.recent.load("owner", [{ accountName: "Main", characters: [character("Slow"), character("Qiylyn")] }]);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.entries.map(entry => entry.id), ["q1"]);
});

test("Bible is asked about two characters at a time, as Auto-sync does", async () => {
  const characters = Array.from({ length: 6 }, (_, i) => character(`Char${i}`));
  const f = fixture();
  await f.recent.load("owner", [{ accountName: "Main", characters }]);
  assert.equal(f.calls.length, 6);
  assert.equal(f.maxInFlight, 2);
});

test("once the deadline passes, a character still waiting its turn is never asked", async () => {
  const f = fixture({ hang: ["Alpha"], held: ["Bravo"] });
  await assert.rejects(f.recent.load("owner", [{ accountName: "Main", characters: [
    character("Alpha", { itemLevel: 1780 }), character("Bravo", { itemLevel: 1770 }), character("Charlie", { itemLevel: 1760 }),
  ] }]), { code: "timeout" });
  f.release("Bravo");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => call[1]), ["Alpha", "Bravo"]);
});

test("an empty successful character cannot hide another character's 429 or cache a false empty roster", async () => {
  const limited = Object.assign(new Error("HTTP 429"), { status: 429 });
  const f = fixture({ errors: { Bravo: limited } });
  const accounts = [{ accountName: "Main", characters: [character("Alpha"), character("Bravo")] }];
  await assert.rejects(f.recent.load("owner", accounts), error => error === limited);
  await assert.rejects(f.recent.load("owner", accounts), error => error === limited);
  assert.equal(f.calls.length, 4);
});

test("cache follows roster membership, Bible identity and fresh private flags", async () => {
  const f = fixture({ rowsByName: {
    Alpha: [bibleRow("a", "Alpha", NOW)], Bravo: [bibleRow("b", "Bravo", NOW)],
  } });
  const accounts = names => [{ accountName: "Main", characters: names.map(name => character(name)) }];
  assert.equal((await f.recent.load("owner", accounts(["Alpha"]))).entries[0].character, "Alpha");
  assert.equal((await f.recent.load("owner", accounts(["Bravo"]))).entries[0].character, "Bravo");
  const updated = accounts(["Bravo"]);
  updated[0].characters[0].bibleRid = 9;
  await f.recent.load("owner", updated);
  assert.equal(f.calls.at(-1)[2].rid, 9);
  Object.assign(updated[0].characters[0], { publicLogDisabled: true, publicLogDisabledAt: new Date(NOW) });
  const locked = await f.recent.load("owner", updated);
  assert.deepEqual([locked.entries, locked.private], [[], ["Bravo"]]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual((await f.recent.load("owner", [])).entries, []);
});

test("a private flag aging past the daily skip invalidates an otherwise fresh cache", async () => {
  const f = fixture({ rowsByName: { Qiylyn: [bibleRow("q1", "Qiylyn", NOW)] } });
  const accounts = [{ characters: [character("Qiylyn", { publicLogDisabled: true,
    publicLogDisabledAt: new Date(NOW - 24 * HOUR + 1000) })] }];
  assert.deepEqual((await f.recent.load("owner", accounts)).private, ["Qiylyn"]);
  f.advance(1001);
  assert.equal((await f.recent.load("owner", accounts)).entries[0].id, "q1");
  assert.equal(f.calls.length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("parallel panels share normal loads; a refresh supersedes an older load without being overwritten", async () => {
  const reads = [deferred(), deferred()];
  let calls = 0;
  const recent = createRecentRaidLogs({ log: silentLog, client: {
    fetchBibleLogsWithLimiter: () => reads[calls++].promise,
  } });
  const accounts = [{ characters: [character("Qiylyn")] }];
  const first = recent.load("owner", accounts);
  const same = recent.load("owner", accounts);
  assert.equal(calls, 1);
  const refresh = recent.load("owner", accounts, { refresh: true });
  const sameRefresh = recent.load("owner", accounts, { refresh: true });
  const duringRefresh = recent.load("owner", accounts);
  assert.equal(calls, 2);
  reads[1].resolve([bibleRow("new", "Qiylyn", NOW)]);
  const latest = await refresh;
  assert.equal(await sameRefresh, latest);
  assert.equal(await duringRefresh, latest);
  reads[0].resolve([bibleRow("old", "Qiylyn", NOW - HOUR)]);
  assert.equal(await first, await same);
  assert.equal((await recent.load("owner", accounts)).entries[0].id, "new");
  assert.equal(calls, 2);
});

test("a changed roster does not join an older in-flight roster load or reuse its result", async () => {
  const held = deferred();
  const recent = createRecentRaidLogs({ log: silentLog, client: {
    fetchBibleLogsWithLimiter: ({ serial }) => serial === "sn-Alpha" ? held.promise : [],
  } });
  const first = recent.load("owner", [{ characters: [character("Alpha")] }]);
  const privateRoster = [{ characters: [character("Alpha", { publicLogDisabled: true, publicLogDisabledAt: new Date() })] }];
  const current = await recent.load("owner", privateRoster);
  held.resolve([bibleRow("old", "Alpha", NOW)]);
  await first;
  assert.equal(await recent.load("owner", privateRoster), current);
  assert.deepEqual([current.entries, current.private], [[], ["Alpha"]]);
});

test("a profile arriving after the deadline cannot start a logs request; a retry is not served an empty cache", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = deferred();
  let profiles = 0;
  let logs = 0;
  let signal;
  const recent = createRecentRaidLogs({ log: silentLog, deadlineMs: 45_000, client: {
    fetchBibleCharacterProfileWithLimiter: (_, options) => { profiles++; signal = options.signal; return held.promise; },
    fetchBibleLogsWithLimiter: async () => { logs++; return [bibleRow("q1", "Qiylyn", NOW)]; },
  } });
  const accounts = [{ characters: [{ name: "Qiylyn", class: "Aeromancer", itemLevel: 1760 }] }];
  const first = recent.load("owner", accounts);
  const rejected = assert.rejects(first, { code: "timeout" });
  t.mock.timers.tick(45_000);
  await rejected;
  assert.equal(signal.aborted, true);
  held.resolve({ sn: "sn-Qiylyn", cid: 1, rid: 2, className: "Aeromancer" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs, 0);
  assert.equal((await recent.load("owner", accounts)).entries[0].id, "q1");
  assert.deepEqual([profiles, logs], [2, 1]);
});

test("results stay for five minutes per owner; refresh reads again; at most 25 entries", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => bibleRow(`q${i}`, "Qiylyn", NOW - i * HOUR));
  const f = fixture({ rowsByName: { Qiylyn: rows } });
  const accounts = [{ accountName: "Main", characters: [character("Qiylyn")] }];
  const first = await f.recent.load("owner", accounts);
  assert.equal(first.entries.length, 25);
  assert.equal(await f.recent.load("owner", accounts), first);
  assert.equal(f.calls.length, 1);
  await f.recent.load("owner", accounts, { refresh: true });
  assert.equal(f.calls.length, 2);
  f.advance(5 * 60_000);
  await f.recent.load("owner", accounts);
  assert.equal(f.calls.length, 3);
});
