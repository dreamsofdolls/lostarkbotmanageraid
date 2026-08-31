"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Events } = require("discord.js");

const {
  installDiscordGatewayDiagnostics,
  startDiscordLogin,
} = require("../bot/app/discord-startup");

function createFakeTimers() {
  const active = new Map();
  let nextId = 0;

  return {
    active,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      active.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) {
      active.delete(id);
    },
  };
}

test("Discord login clears its watchdog after becoming ready", async () => {
  const timers = createFakeTimers();
  const terminations = [];
  const messages = [];

  const result = await startDiscordLogin({
    client: { login: async (token) => assert.equal(token, "token") },
    token: "token",
    terminate: async (payload) => terminations.push(payload),
    timeoutMs: 45_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: (message) => messages.push(message) },
  });

  assert.equal(result, true);
  assert.deepEqual(terminations, []);
  assert.deepEqual(messages, [
    "[bot] Connecting to Discord gateway (timeout 45s)...",
  ]);
  assert.equal(timers.active.size, 0);
});

test("Discord login timeout terminates a silently pending gateway connection", async () => {
  const timers = createFakeTimers();
  const terminations = [];

  const login = startDiscordLogin({
    client: { login: () => new Promise(() => {}) },
    token: "token",
    terminate: async (payload) => terminations.push(payload),
    timeoutMs: 60_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: () => {} },
  });

  const [{ callback, delay }] = timers.active.values();
  assert.equal(delay, 60_000);
  callback();

  assert.equal(await login, false);
  assert.deepEqual(terminations, [{
    label: "Discord login timed out after 60s",
    error: null,
    exitCode: 1,
  }]);
  assert.equal(timers.active.size, 0);
});

test("Discord login rejection retains the original error for Railway logs", async () => {
  const timers = createFakeTimers();
  const error = new Error("invalid token");
  const terminations = [];

  const result = await startDiscordLogin({
    client: { login: async () => { throw error; } },
    token: "token",
    terminate: async (payload) => terminations.push(payload),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: () => {} },
  });

  assert.equal(result, false);
  assert.deepEqual(terminations, [{
    label: "Discord login failed",
    error,
    exitCode: 1,
  }]);
  assert.equal(timers.active.size, 0);
});

test("gateway diagnostics log shard errors, disconnects, and reconnects", () => {
  const client = new EventEmitter();
  const errors = [];
  const warnings = [];
  const error = new Error("socket reset");

  installDiscordGatewayDiagnostics(client, {
    logger: {
      error: (...parts) => errors.push(parts),
      warn: (...parts) => warnings.push(parts),
    },
  });

  client.emit(Events.ShardError, error, 2);
  client.emit(Events.ShardDisconnect, { code: 1006 }, 2);
  client.emit(Events.ShardReconnecting, 2);

  assert.deepEqual(errors, [["[bot] Discord shard 2 error:", error]]);
  assert.deepEqual(warnings, [
    ["[bot] Discord shard 2 disconnected (code 1006)."],
    ["[bot] Discord shard 2 reconnecting..."],
  ]);
});

test("Discord login rejects a non-positive watchdog configuration", async () => {
  await assert.rejects(
    startDiscordLogin({ timeoutMs: 0 }),
    /timeout must be a positive number/
  );
});
