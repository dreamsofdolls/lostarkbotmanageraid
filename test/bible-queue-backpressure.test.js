"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");
const { raidLogErrorCode } = require("../bot/services/raid-log/errors");

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function heldLimiter(t, options = {}, concurrency = 1) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const limiter = new BibleRequestLimiter(concurrency, { log: {}, ...options });
  const run = (fn, requestOptions) => {
    const request = limiter.run(fn, requestOptions);
    requests.push(request);
    request.catch(() => {});
    return request;
  };
  t.after(async () => {
    release();
    await Promise.allSettled(requests);
  });
  return { limiter, run, gate, release };
}

test("Bible limiter retains at most 32 waiters during a 256-request burst", async t => {
  const held = heldLimiter(t, {}, 2);
  const rejected = [];
  for (let index = 0; index < 256; index++) {
    held.run(() => held.gate).catch(error => { rejected.push(error); });
  }
  await nextTurn();

  assert.equal(held.limiter.active, 2);
  assert.equal(held.limiter.queue.length, 32);
  assert.equal(rejected.length, 222);
  assert.ok(rejected.every(error => error.code === "BIBLE_QUEUE_FULL"));
  assert.equal(raidLogErrorCode(rejected[0]), "busy");
  assert.equal(held.limiter.getBackoffRemainingMs(), 0);
});

test("Bible queue rejects excess requests before adding abort listeners", async t => {
  const held = heldLimiter(t, { maxPending: 1 });
  held.run(() => held.gate);
  held.run(async () => "queued");
  const controller = new AbortController();
  let started = false;
  let outcome;
  held.run(() => { started = true; }, { signal: controller.signal })
    .catch(error => { outcome = error; });
  await nextTurn();

  assert.equal(outcome?.code, "BIBLE_QUEUE_FULL");
  assert.equal(started, false);
  assert.equal(held.limiter.queue.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("Bible queue timeout releases a waiter without ending the active request or opening backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = heldLimiter(t, { maxQueueWaitMs: 25 });
  held.run(() => held.gate);
  const controller = new AbortController();
  let started = false;
  let outcome;
  held.run(() => { started = true; }, { signal: controller.signal })
    .catch(error => { outcome = error; });
  t.mock.timers.tick(25);
  await nextTurn();

  assert.equal(outcome?.name, "TimeoutError");
  assert.equal(raidLogErrorCode(outcome), "timeout");
  assert.equal(held.limiter.active, 1);
  assert.equal(held.limiter.queue.length, 0);
  assert.equal(started, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(held.limiter.getBackoffRemainingMs(), 0);
  const recovered = held.run(async () => "recovered");
  held.release();
  assert.equal(await recovered, "recovered");
});

test("Bible queue rechecks elapsed wait time when timer callbacks have not run yet", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const held = heldLimiter(t, { maxQueueWaitMs: 25 });
  held.run(() => held.gate);
  let started = false;
  const queued = held.run(() => { started = true; });
  t.mock.timers.tick(25);
  held.release();
  await assert.rejects(queued, { name: "TimeoutError" });
  assert.equal(started, false);
  assert.equal(held.limiter.queue.length, 0);
});

test("Bible queue does not start HTTP if its deadline passes between dispatch and the callback", async t => {
  let now = 0;
  const held = heldLimiter(t, { maxQueueWaitMs: 25, nowMs: () => now });
  held.run(() => held.gate);
  const controller = new AbortController();
  let started = false;
  const queued = held.run(() => { started = true; }, { signal: controller.signal });
  held.release();
  // Observe slot assignment before the callback's next microtask executes.
  for (let turn = 0; turn < 50 && held.limiter.queue.length; turn++) await Promise.resolve();
  assert.equal(held.limiter.queue.length, 0);
  assert.equal(started, false);
  now = 25;
  await assert.rejects(queued, { name: "TimeoutError" });
  assert.equal(started, false);
  assert.equal(held.limiter.active, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(await held.run(async () => "recovered"), "recovered");
});

test("aborting a Bible waiter frees capacity and keeps surviving requests in FIFO order", async t => {
  const held = heldLimiter(t, { maxPending: 2 });
  const started = [];
  held.run(() => held.gate);
  const controller = new AbortController();
  const cancelled = held.run(() => { started.push("cancelled"); }, { signal: controller.signal });
  held.run(() => { started.push("second"); });
  controller.abort();
  const third = held.run(() => { started.push("third"); });
  await assert.rejects(cancelled, { name: "AbortError" });
  held.release();
  await third;

  assert.deepEqual(started, ["second", "third"]);
  assert.equal(held.limiter.queue.length, 0);
});

test("Bible limiter with no waiting capacity still accepts consecutive completed requests", async () => {
  const limiter = new BibleRequestLimiter(1, { maxPending: 0, log: {} });
  assert.equal(await limiter.run(async () => "first"), "first");
  assert.equal(limiter.active, 0);
  assert.equal(await limiter.run(async () => "next"), "next");
  assert.equal(limiter.active, 0);
});
