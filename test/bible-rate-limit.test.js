"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BibleRequestLimiter,
  createBibleHttpError,
  parseRetryAfterMs,
} = require("../bot/services/auto-manage/bible/rate-limit");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("Bible limiter preserves its concurrency cap", async () => {
  const gates = [deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;
  let started = 0;
  const limiter = new BibleRequestLimiter(2);

  const jobs = gates.map((gate) => limiter.run(async () => {
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  assert.equal(peak, 2);

  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 3);

  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(jobs);
});

test("Bible limiter opens one global circuit and rejects queued work after HTTP 429", async () => {
  let now = 10_000;
  const firstGate = deferred();
  let queuedStarted = false;
  const limiter = new BibleRequestLimiter(1, {
    defaultBackoffMs: 5_000,
    nowMs: () => now,
    log: { warn: () => {} },
  });

  const first = limiter.run(() => firstGate.promise);
  const queued = limiter.run(async () => {
    queuedStarted = true;
  });
  const settled = Promise.allSettled([first, queued]);

  await new Promise((resolve) => setImmediate(resolve));
  const rateLimitError = new Error("LostArk Bible HTTP 429");
  rateLimitError.status = 429;
  rateLimitError.retryAfterMs = 3_000;
  firstGate.reject(rateLimitError);

  const [firstResult, queuedResult] = await settled;
  assert.equal(firstResult.status, "rejected");
  assert.equal(queuedResult.status, "rejected");
  assert.equal(queuedResult.reason.status, 429);
  assert.equal(queuedResult.reason.isBibleBackoff, true);
  assert.equal(queuedStarted, false);
  assert.equal(limiter.getBackoffRemainingMs(), 3_000);

  await assert.rejects(
    limiter.run(() => assert.fail("request must not start during backoff")),
    (error) => error.status === 429 && error.retryAfterMs === 3_000
  );

  now += 3_000;
  assert.equal(await limiter.run(async () => "recovered"), "recovered");
});

test("Bible HTTP errors carry Retry-After seconds or dates into the limiter", () => {
  const now = Date.parse("2026-09-20T08:00:00Z");
  assert.equal(parseRetryAfterMs("12", now), 12_000);
  assert.equal(
    parseRetryAfterMs("Sun, 20 Sep 2026 08:00:30 GMT", now),
    30_000
  );
  assert.equal(parseRetryAfterMs("invalid", now), null);

  const error = createBibleHttpError(
    "LostArk Bible HTTP 429",
    {
      status: 429,
      headers: { get: (name) => name === "retry-after" ? "7" : null },
    },
    now
  );
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 7_000);
});
