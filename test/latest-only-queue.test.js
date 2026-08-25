"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLatestOnlyQueue,
} = require("../bot/utils/async/latest-only-queue");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("latest-only queue coalesces requests made before rendering starts", async () => {
  const calls = [];
  const queue = createLatestOnlyQueue(async (labels) => {
    calls.push(labels);
  });

  queue.request("roster");
  queue.request("teams");
  await queue.flush();

  assert.deepEqual(calls, [["roster", "teams"]]);
});

test("latest-only queue runs one follow-up for every update received in flight", async () => {
  const firstRunEntered = deferred();
  const releaseFirstRun = deferred();
  const calls = [];
  const queue = createLatestOnlyQueue(async (labels) => {
    calls.push(labels);
    if (calls.length === 1) {
      firstRunEntered.resolve();
      await releaseFirstRun.promise;
    }
  });

  queue.request("first");
  await firstRunEntered.promise;
  queue.request("second");
  queue.request("third");
  releaseFirstRun.resolve();
  await queue.flush();

  assert.deepEqual(calls, [["first"], ["second", "third"]]);
});

test("latest-only queue reports failures and remains usable", async () => {
  const errors = [];
  let runs = 0;
  const queue = createLatestOnlyQueue(
    async () => {
      runs += 1;
      if (runs === 1) throw new Error("temporary render failure");
    },
    {
      onError: (err, labels) => errors.push([err.message, labels]),
    }
  );

  queue.request("broken");
  await queue.flush();
  queue.request("recovered");
  await queue.flush();

  assert.equal(runs, 2);
  assert.deepEqual(errors, [["temporary render failure", ["broken"]]]);
});
