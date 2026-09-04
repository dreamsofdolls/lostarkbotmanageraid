"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createInFlightLoader } = require("../bot/utils/async/in-flight-loader");

test("createInFlightLoader coalesces overlap and keeps a resolved value for its TTL", async () => {
  let clock = 0;
  let calls = 0;
  let releaseFirst;
  const loader = createInFlightLoader(
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return `value-${calls}`;
    },
    { ttlMs: 100, maxEntries: 10, now: () => clock }
  );

  const first = loader("user-1");
  const overlapping = loader("user-1");
  assert.equal(first, overlapping);
  await Promise.resolve();
  releaseFirst("value-1");
  assert.equal(await first, "value-1");
  assert.equal(await loader("user-1"), "value-1");
  assert.equal(calls, 1);

  clock = 100;
  assert.equal(await loader("user-1"), "value-2");
  assert.equal(calls, 2);
});

test("createInFlightLoader never caches failures and supports explicit invalidation", async () => {
  let calls = 0;
  const loader = createInFlightLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return calls;
  }, { ttlMs: 1_000 });

  await assert.rejects(() => loader("user-1"), /temporary failure/);
  assert.equal(await loader("user-1"), 2);
  assert.equal(loader.invalidate("user-1"), true);
  assert.equal(await loader("user-1"), 3);
});

test("createInFlightLoader keeps resolved caching opt-in", async () => {
  let calls = 0;
  const loader = createInFlightLoader(async () => ++calls);

  assert.equal(await loader("command-user"), 1);
  assert.equal(await loader("command-user"), 2);
});

test("createInFlightLoader bounds settled entries with LRU eviction", async () => {
  let calls = 0;
  const loader = createInFlightLoader(
    async (key) => `${key}-${++calls}`,
    { ttlMs: 1_000, maxEntries: 2 }
  );

  assert.equal(await loader("a"), "a-1");
  assert.equal(await loader("b"), "b-2");
  assert.equal(await loader("a"), "a-1"); // touch a; b is now oldest
  assert.equal(await loader("c"), "c-3");
  assert.equal(loader.cachedKeyCount(), 2);
  assert.equal(await loader("b"), "b-4");
});

test("createInFlightLoader trims a completed burst without evicting pending work", async () => {
  const releases = new Map();
  const loader = createInFlightLoader(
    (key) => new Promise((resolve) => releases.set(key, resolve)),
    { ttlMs: 1_000, maxEntries: 2 }
  );
  const first = loader("a");
  const second = loader("b");
  const third = loader("c");
  await Promise.resolve();
  assert.equal(loader.cachedKeyCount(), 3);

  releases.get("a")("a");
  assert.equal(await first, "a");
  assert.equal(loader("b"), second);
  assert.equal(loader("c"), third);

  releases.get("b")("b");
  releases.get("c")("c");
  assert.deepEqual(await Promise.all([second, third]), ["b", "c"]);
  assert.equal(loader.cachedKeyCount(), 2);
  assert.equal(loader("b"), second);
  assert.equal(loader("c"), third);
});

test("an invalidated request finishing late cannot evict the replacement cache", async () => {
  let releaseOld;
  let calls = 0;
  const loader = createInFlightLoader(
    () => ++calls === 1 ? new Promise((resolve) => { releaseOld = resolve; }) : "new",
    { ttlMs: 1_000, maxEntries: 1 }
  );
  const old = loader("a");
  await Promise.resolve();
  loader.invalidate("a");
  const replacement = loader("a");
  assert.equal(await replacement, "new");

  releaseOld("old");
  assert.equal(await old, "old");
  assert.equal(loader("a"), replacement);
  assert.equal(loader.cachedKeyCount(), 1);
});
