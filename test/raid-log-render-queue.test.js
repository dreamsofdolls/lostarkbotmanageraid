"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRenderQueue } = require("../bot/services/raid-log/render-queue");

test("render queue is bounded and runs jobs in order, including after a failed render", async () => {
  const queue = createRenderQueue({ maxPending: 2 });
  const order = [];
  let release;
  const first = queue.run(() => new Promise(resolve => { order.push(1); release = resolve; }), Date.now() + 10000);
  const second = queue.run(() => { order.push(2); throw new Error("render failed"); }, Date.now() + 10000);
  const rejected = assert.rejects(second, /render failed/);
  const third = queue.run(() => { order.push(3); return "ready"; }, Date.now() + 10000);
  await assert.rejects(queue.run(() => assert.fail("over capacity"), Date.now() + 10000), { code: "busy" });
  assert.deepEqual(order, [1]);
  release();
  await first;
  await rejected;
  assert.equal(await third, "ready");
  assert.deepEqual(order, [1, 2, 3]);
});

test("expired queued jobs reject before the active render finishes and never run later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = createRenderQueue({ maxPending: 1 });
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }), 100);
  const expired = queue.run(() => assert.fail("expired job ran"), 10);
  const rejected = assert.rejects(expired, { code: "timeout" });
  await Promise.resolve();
  t.mock.timers.tick(10);
  await rejected;
  const next = queue.run(() => "next", 100);
  release();
  await first;
  assert.equal(await next, "next");
});
