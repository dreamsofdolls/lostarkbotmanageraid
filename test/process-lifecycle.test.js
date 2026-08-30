"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createProcessTerminator,
  installProcessLifecycle,
} = require("../bot/app/process-lifecycle");

test("fatal termination closes Local Reader, Discord, and Mongo before exiting", async () => {
  const order = [];
  const terminate = createProcessTerminator({
    client: { destroy: async () => order.push("discord") },
    getLocalSyncWeb: () => ({ stop: async () => order.push("http") }),
    disconnect: async () => order.push("mongo"),
    exit: (code) => order.push(`exit:${code}`),
    logger: { error: () => order.push("log"), warn: () => {}, log: () => {} },
  });

  const first = await terminate({
    label: "Ready bootstrap failed",
    error: new Error("Discord unavailable"),
    exitCode: 1,
  });
  const second = await terminate({ label: "duplicate", exitCode: 1 });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.deepEqual(order, ["log", "http", "discord", "mongo", "exit:1"]);
});

test("SIGTERM is registered as a graceful zero-exit lifecycle event", async () => {
  const processRef = new EventEmitter();
  const calls = [];
  installProcessLifecycle({
    processRef,
    terminate: async (payload) => calls.push(payload),
  });

  processRef.emit("SIGTERM");
  await Promise.resolve();

  assert.deepEqual(calls, [{
    label: "SIGTERM received, shutting down...",
    exitCode: 0,
  }]);
});
