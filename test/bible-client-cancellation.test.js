"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBibleClient } = require("../bot/services/auto-manage/bible/client");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");
const { silentLog } = require("./helpers/silent-log");

const requests = {
  profile: (client, signal) => client.fetchBibleCharacterProfileWithLimiter("Qiylyn", { signal }),
  logs: (client, signal) => client.fetchBibleLogsWithLimiter({ serial: "sn", cid: 1, rid: 2, className: "Aeromancer" }, { signal }),
};

for (const [name, request] of Object.entries(requests)) {
  test(`${name}: abort before dispatch prevents HTTP even when queued behind another Bible request`, async () => {
    const limiter = new BibleRequestLimiter(1, { log: silentLog });
    let release;
    const held = limiter.run(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    let fetches = 0;
    const client = createBibleClient({ bibleLimiter: limiter, fetchImpl: async () => { fetches++; return new Response("[]"); } });
    const controller = new AbortController();
    const queued = request(client, controller.signal);
    const reason = new DOMException("expired", "TimeoutError");
    controller.abort(reason);
    const rejected = assert.rejects(queued, error => error === reason);
    release();
    await held;
    await rejected;
    await assert.rejects(request(client, controller.signal), error => error === reason);
    assert.equal(fetches, 0);
    assert.equal(limiter.getBackoffRemainingMs(), 0);
    // A cancelled Recent request must not poison unrelated callers.
    await client.fetchBibleLogsWithLimiter({ serial: "other", cid: 1, rid: 2, className: "Bard" });
    assert.equal(fetches, 1);
  });

  test(`${name}: abort reaches an in-flight HTTP request and releases the shared limiter`, async () => {
    const limiter = new BibleRequestLimiter(1, { log: silentLog });
    let received;
    const client = createBibleClient({ bibleLimiter: limiter, fetchImpl: async (_, { signal }) => {
      received = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const controller = new AbortController();
    const active = request(client, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.aborted, false);
    const rejected = assert.rejects(active, { name: "TimeoutError" });
    controller.abort(new DOMException("expired", "TimeoutError"));
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.aborted, true);
    assert.equal(limiter.active, 0);
  });
}
