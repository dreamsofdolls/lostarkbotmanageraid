"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaidLogCatalog, normalizeCatalogLogs } = require("../bot/services/raid-log/catalog");
const { raidLogErrorCode } = require("../bot/services/raid-log/errors");
const { createImageCache } = require("../bot/services/raid-log/image-cache");
const { createBibleClient } = require("../bot/services/auto-manage/bible/client");
const { createBibleCharacterNotFoundError } = require("../bot/services/auto-manage/bible/error-kinds");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");

const row = (id, boss = "Death Incarnate Kazeros", timestamp = 100) => ({ id, boss, timestamp, name: "Qiylyn", difficulty: "Hard" });

test("catalog groups known gates, preserves unknown raids and rejects malformed or wrong-character rows", () => {
  const logs = normalizeCatalogLogs([row("g2"), row("g1", "Abyss Lord Kazeros"), row("other", "Unknown boss")], "Qiylyn");
  assert.deepEqual(logs.slice(0, 2).map(x => [x.raidKey, x.gate]), [["kazeros", "G2"], ["kazeros", "G1"]]);
  assert.equal(logs[2].raidLabel, "Unknown boss");
  assert.match(logs[2].raidKey, /^boss-/);
  assert.equal(normalizeCatalogLogs([row("yes"), { ...row("no"), name: "Other" }], "qiylyn").length, 1);
  for (const item of [{ ...row("x"), timestamp: 1e30 }, { ...row("x"), timestamp: null }, row("../bad")]) {
    assert.throws(() => normalizeCatalogLogs([item], "Qiylyn"), { code: "unavailable" });
  }
  assert.throws(() => normalizeCatalogLogs([row("x")], "Other"), { code: "character_mismatch" });
});

test("catalog opens one page, loads older pages lazily, deduplicates and checks privacy on every verification", async () => {
  const calls = [];
  let privateLogs = false;
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async name => {
      calls.push(["profile", name]);
      return { name: "Qiylyn", cid: 1, sn: "s", rid: 2, className: "Aeromancer" };
    },
    fetchBibleLogsWithLimiter: async args => {
      calls.push(["logs", args.page]);
      if (privateLogs) throw Object.assign(new Error("Logs not enabled"), { status: 403, bodyText: '{"error":"Logs not enabled"}' });
      return args.page === 1
        ? Array.from({ length: 25 }, (_, i) => row(`a${i}`, undefined, 100 - i))
        : [row("a24"), row("old", "Witch of Agony, Serca", 5)];
    },
  } });
  const first = await catalog.open("qiylyn");
  assert.deepEqual(calls, [["profile", "qiylyn"], ["logs", 1]]);
  assert.equal(first.logs.length, 25);
  assert.equal(first.hasMore, true);
  const more = await catalog.more(first);
  assert.equal(more.logs.length, 26);
  assert.equal(more.hasMore, false);
  assert.equal(first.logs.length, 25);
  await catalog.verify(more);
  assert.deepEqual(calls.at(-1), ["logs", 1]);
  privateLogs = true;
  await assert.rejects(catalog.verify(more), error => raidLogErrorCode(error) === "logs_private");
  await assert.rejects(catalog.more(more), { code: "invalid_selection" });
});

test("empty or mismatching catalog never becomes a selectable panel", async () => {
  let reads = 0;
  const client = {
    fetchBibleCharacterProfileWithLimiter: async () => ({ name: "Other" }),
    fetchBibleLogsWithLimiter: async () => { reads++; return []; },
  };
  await assert.rejects(createRaidLogCatalog({ client }).open("Qiylyn"), { code: "character_mismatch" });
  assert.equal(reads, 0);
  client.fetchBibleCharacterProfileWithLimiter = async () => ({ name: "Qiylyn" });
  await assert.rejects(createRaidLogCatalog({ client }).open("Qiylyn"), { code: "no_logs" });
});

test("opening an exact Recent log searches later pages, stopping as soon as it is found", async () => {
  const reads = [];
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async () => ({ name: "Qiylyn" }),
    fetchBibleLogsWithLimiter: async ({ page }) => {
      reads.push(page);
      return page === 1 ? Array.from({ length: 25 }, (_, i) => row(`a${i}`, undefined, 100 - i)) : [row("target", undefined, 1)];
    },
  } });
  const first = await catalog.open("Qiylyn", { logId: "a1" });
  assert.equal(first.page, 1);
  assert.deepEqual(reads, [1]);
  reads.length = 0;
  const found = await catalog.open("Qiylyn", { logId: "target" });
  assert.equal(found.page, 2);
  assert.equal(found.logs.at(-1).id, "target");
  assert.deepEqual(reads, [1, 2]);
});

test("catalog lookup shares one timeout across profile and history pages", async t => {
  const controller = new AbortController();
  let timeouts = 0;
  t.mock.method(AbortSignal, "timeout", ms => {
    assert.equal(ms, 30000); timeouts++; return controller.signal;
  });
  const seen = [];
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async (_, { signal }) => { seen.push(signal); return { name: "Qiylyn" }; },
    fetchBibleLogsWithLimiter: async ({ page }, { signal }) => {
      seen.push(signal);
      return page === 1 ? Array.from({ length: 25 }, (_, i) => row(`p${i}`)) : [row("target")];
    },
  } });
  await catalog.open("Qiylyn", { logId: "target" });
  assert.equal(timeouts, 1);
  assert.deepEqual(seen, [controller.signal, controller.signal, controller.signal]);
});

test("catalog operations expire while queued without waiting for unrelated Bible work", async t => {
  const limiter = new BibleRequestLimiter(1, { log: {} });
  let release;
  const held = limiter.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const client = createBibleClient({ bibleLimiter: limiter, fetchImpl: () => assert.fail("expired catalog request reached HTTP") });
  const service = createRaidLogCatalog({ client });
  const current = { profile: { name: "Qiylyn", sn: "s", cid: 1, rid: 2 }, page: 1, hasMore: true };
  let controller;
  t.mock.method(AbortSignal, "timeout", ms => {
    assert.equal(ms, 30000);
    controller = new AbortController();
    return controller.signal;
  });
  try {
    for (const run of [() => service.open("Qiylyn"), () => service.verify(current), () => service.refresh(current), () => service.more(current)]) {
      const result = run();
      assert.equal(limiter.queue.length, 1);
      const rejected = assert.rejects(result, error => raidLogErrorCode(error) === "timeout");
      controller.abort(new DOMException("expired", "TimeoutError"));
      await rejected;
      assert.equal(limiter.queue.length, 0);
      assert.equal(limiter.active, 1);
    }
  } finally { release(); await held; }
});

test("exact-log lookup preserves page, duplicate and privacy guards", async () => {
  const reads = [];
  let mode = "unique";
  const privateError = Object.assign(new Error("Logs not enabled"), { status: 403 });
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async () => ({ name: "Qiylyn" }),
    fetchBibleLogsWithLimiter: async ({ page }) => {
      reads.push(page);
      if (mode === "private" && page === 2) throw privateError;
      if (mode === "empty" && page === 2) return [];
      return Array.from({ length: 25 }, (_, i) => row(`p${mode === "repeat" ? 1 : page}a${i}`, undefined, 1000 - page * 25 - i));
    },
  } });
  const bounded = await catalog.open("Qiylyn", { logId: "missing" });
  assert.equal(bounded.page, 10);
  assert.equal(bounded.logs.length, 250);
  assert.equal(bounded.hasMore, false);
  assert.equal(reads.length, 10);
  for (mode of ["repeat", "empty"]) {
    reads.length = 0;
    const missing = await catalog.open("Qiylyn", { logId: "missing" });
    assert.equal(missing.hasMore, false);
    assert.deepEqual(reads, [1, 2]);
  }
  mode = "private";
  await assert.rejects(catalog.open("Qiylyn", { logId: "missing" }), error => error === privateError);
});

test("repeated source pages stop loading without claiming extra history, and history stops at its page budget", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(`a${i}`, undefined, 100 - i));
  let reads = 0;
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async () => ({ name: "Qiylyn" }),
    fetchBibleLogsWithLimiter: async () => { reads++; return rows; },
  } });
  const first = await catalog.open("Qiylyn");
  const repeated = await catalog.more(first);
  assert.equal(repeated.hasMore, false);
  assert.equal(repeated.logs.length, 25);
  await assert.rejects(catalog.more(repeated), { code: "invalid_selection" });
  await assert.rejects(catalog.more({ ...first, page: 10 }), { code: "invalid_selection" });
  assert.equal(reads, 2);
});

test("image cache enforces byte budget, LRU and TTL without retaining oversized images", () => {
  let now = 0;
  const cache = createImageCache({ maxBytes: 6, ttlMs: 10, now: () => now });
  const result = id => ({ id, images: [{ buffer: Buffer.alloc(3) }] });
  cache.set("a", result("a"));
  cache.set("b", result("b"));
  cache.get("a");
  cache.set("c", result("c"));
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a").id, "a");
  cache.set("huge", { images: [{ buffer: Buffer.alloc(7) }] });
  assert.equal(cache.get("huge"), undefined);
  now = 10;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  cache.set("d", result("d"));
  assert.equal(cache.get("d").id, "d");
});

test("two-image cache accounts for both buffers and refresh invalidates every variant of only that log", () => {
  const cache = createImageCache({ maxBytes: 10 });
  const pair = { images: [{ buffer: Buffer.alloc(3) }, { buffer: Buffer.alloc(4) }] };
  cache.set("log:player1", pair);
  cache.set("log:player2", pair);
  assert.equal(cache.get("log:player1"), undefined);
  assert.equal(cache.get("log:player2"), pair);
  cache.set("other:team", { images: [{ buffer: Buffer.alloc(3) }] });
  cache.invalidateLog("log");
  assert.equal(cache.get("log:player2"), undefined);
  assert.ok(cache.get("other:team"));
  cache.set("huge:detail", { images: [{ buffer: Buffer.alloc(6) }, { buffer: Buffer.alloc(6) }] });
  assert.equal(cache.get("huge:detail"), undefined);
});

test("catalog refresh fetches once, keeps older history, updates existing metadata and enforces privacy", async () => {
  let reads = 0;
  let rows = [row("latest", undefined, 200), row("old", "Abyss Lord Kazeros", 100)];
  const service = createRaidLogCatalog({ client: { fetchBibleLogsWithLimiter: async () => { reads++; return rows; } } });
  const current = { profile: { name: "Qiylyn" }, logs: normalizeCatalogLogs([row("old"), row("history", undefined, 1)], "Qiylyn"), page: 2, hasMore: false };
  const refreshed = await service.refresh(current);
  assert.equal(reads, 1);
  assert.deepEqual(refreshed.logs.map(log => log.id), ["latest", "old", "history"]);
  assert.equal(refreshed.logs[1].gate, "G1");
  assert.equal(current.logs[0].gate, "G2");
  rows = [];
  await assert.rejects(service.refresh(current), { code: "no_logs" });
});

test("refresh followed by older-page loading cannot grow history past 250 logs", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(`new${i}`, undefined, 1000 - i));
  const service = createRaidLogCatalog({ client: { fetchBibleLogsWithLimiter: async () => rows } });
  const current = { profile: { name: "Qiylyn" },
    logs: normalizeCatalogLogs(Array.from({ length: 240 }, (_, i) => row(`old${i}`, undefined, 500 - i)), "Qiylyn"),
    page: 2, hasMore: true };
  for (const result of [await service.refresh(current), await service.more(current)]) {
    assert.equal(result.logs.length, 250);
    assert.equal(result.hasMore, false);
    await assert.rejects(service.more(result), { code: "invalid_selection" });
  }
});

test("catalog never folds accents or accepts nameless rows as the requested character", () => {
  assert.throws(() => normalizeCatalogLogs([{ ...row("x"), name: "Saturn" }], "Sáturn"), { code: "character_mismatch" });
  assert.throws(() => normalizeCatalogLogs([{ id: "x", boss: "Death Incarnate Kazeros", timestamp: 10 }], "Saturn"), { code: "character_mismatch" });
  const logs = normalizeCatalogLogs([{ ...row("upper"), name: "QIYLYN", timestamp: "200" }, row("lower")], "Qiylyn");
  assert.deepEqual(logs.map(log => [log.id, log.timestamp]), [["upper", 200], ["lower", 100]]);
});

test("a malformed Bible page fails instead of yielding a partial history", () => {
  assert.throws(() => normalizeCatalogLogs({}, "Qiylyn"), { code: "unavailable" });
  for (const item of [{ ...row("x"), timestamp: "oops" }, { ...row("x"), id: undefined }]) {
    assert.throws(() => normalizeCatalogLogs([row("ok"), item], "Qiylyn"), { code: "unavailable" });
  }
});

function openFixture({ profile, logs, profileError, logsError } = {}) {
  const calls = [];
  const catalog = createRaidLogCatalog({ client: {
    fetchBibleCharacterProfileWithLimiter: async name => {
      calls.push(["profile", name]);
      if (profileError) throw profileError;
      return { sn: "serial-1", cid: 123, rid: 456, name: "Saturnxd", className: "Deathblade", ...profile };
    },
    fetchBibleLogsWithLimiter: async args => {
      calls.push(["logs", args]);
      if (logsError) throw logsError;
      return logs ?? [row("ABC")].map(entry => ({ ...entry, name: "Saturnxd" }));
    },
  } });
  return { calls, open: name => catalog.open(name) };
}

test("open resolves exact name and class and requests only page 1 with fresh Bible IDs", async () => {
  const { open, calls } = openFixture();
  const opened = await open("saturnxd");
  assert.equal(opened.logs[0].character, "Saturnxd");
  assert.equal(opened.logs[0].url, "https://lostark.bible/logs/ABC");
  assert.deepEqual(calls, [
    ["profile", "saturnxd"],
    ["logs", { serial: "serial-1", cid: 123, rid: 456, className: "Deathblade", page: 1 }],
  ]);
});

test("open rejects a profile identity mismatch before fetching logs", async () => {
  const { open, calls } = openFixture({ profile: { name: "Other" } });
  await assert.rejects(open("Saturnxd"), { code: "character_mismatch" });
  assert.equal(calls.length, 1);
});

test("error mapping distinguishes unknown names, private logs, blocked access, timeout and backoff", async () => {
  const hasCode = expected => error => raidLogErrorCode(error) === expected;
  const unknown = openFixture({ profileError: createBibleCharacterNotFoundError("Ratelimit") });
  await assert.rejects(unknown.open("Ratelimit"), hasCode("character_not_found"));
  assert.equal(unknown.calls.length, 1);
  await assert.rejects(openFixture({ logs: [] }).open("Saturnxd"), { code: "no_logs" });
  const privateError = Object.assign(new Error('Bible logs API returned HTTP 403 - {"error":"Logs not enabled"}'), { status: 403 });
  await assert.rejects(openFixture({ logsError: privateError }).open("Saturnxd"), hasCode("logs_private"));
  await assert.rejects(openFixture({ logsError: Object.assign(new Error("Blocked"), { status: 403 }) }).open("Saturnxd"), hasCode("unavailable"));
  await assert.rejects(openFixture({ profileError: Object.assign(new Error("Timed out"), { name: "TimeoutError" }) }).open("Saturnxd"), hasCode("timeout"));
  const backoff = Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 60_000 });
  await assert.rejects(openFixture({ logsError: backoff }).open("Saturnxd"), error => error === backoff);
  assert.equal(raidLogErrorCode(backoff), "rate_limited");
  assert.equal(raidLogErrorCode(new Error("Internal path")), "failed");
});

test("real Bible client opens a character with exactly two limited HTTP requests", async () => {
  const calls = [];
  let limitedCalls = 0;
  const html = '<title>Saturnxd (NA) | lostark.bible</title><script>data:{header:{id:123,sn:"serial-1",rid:456,combatPowerHistory:[{score:8000}],class:"blade"},redirectedFrom:null},roster:[{name:"Other",class:"bard"}]</script>';
  const client = createBibleClient({
    bibleLimiter: { run: fn => { limitedCalls++; return fn(); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => html,
        json: async () => [{ id: "ABC", name: "Saturnxd", boss: "Death Incarnate Kazeros", timestamp: 100 }] };
    },
  });
  const opened = await createRaidLogCatalog({ client }).open("saturnxd");
  assert.equal(opened.logs[0].character, "Saturnxd");
  assert.equal(calls.length, 2);
  assert.equal(limitedCalls, 2);
  assert.equal(calls[0].url, "https://lostark.bible/character/NA/saturnxd/roster");
  assert.deepEqual(JSON.parse(calls[1].options.body), { region: "NA", characterSerial: "serial-1", className: "Deathblade", cid: 123, rid: 456, page: 1 });
});

test("catalog keeps Bible's per-log performance fields, with null for missing or non-numeric values", () => {
  const [dealer, support] = normalizeCatalogLogs([
    { ...row("dealer"), spec: "Wind Fury", dps: 1060505447, ndps: 385681991, percentile: 0.9925, normalizedPercentile: 0.9951 },
    { ...row("support", "Corvus Tul Rak", 90), spec: "Desperate Salvation", dps: 12899869, ndps: 12397396,
      rContribution: 0.5259, percentile: 0.7936, contributionPercentile: 0.9737, buffs: [0.934, 0.963, 0.802, 0.328], isDead: true },
  ], "Qiylyn");
  assert.deepEqual(
    [dealer.spec, dealer.dps, dealer.ndps, dealer.percentile, dealer.normalizedPercentile, dealer.contributionPercentile, dealer.isDead],
    ["Wind Fury", 1060505447, 385681991, 0.9925, 0.9951, null, false],
  );
  assert.deepEqual(
    [support.rContribution, support.percentile, support.contributionPercentile, support.buffs, support.isDead, support.isBus],
    [0.5259, 0.7936, 0.9737, [0.934, 0.963, 0.802, 0.328], true, false],
  );
  const [bare] = normalizeCatalogLogs([{ ...row("bare"), percentile: null, dps: "fast", buffs: "x" }], "Qiylyn");
  assert.deepEqual([bare.spec, bare.dps, bare.percentile, bare.rContribution, bare.buffs], ["", null, null, null, null]);
});
