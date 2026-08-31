"use strict";

const { Events } = require("discord.js");

const DISCORD_LOGIN_TIMEOUT_MS = 60_000;

class DiscordLoginTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Discord login did not become ready within ${timeoutMs}ms`);
    this.name = "DiscordLoginTimeoutError";
  }
}

/**
 * Add concise gateway diagnostics without enabling discord.js' very noisy
 * debug stream. These events remain useful after the initial login when a
 * live shard disconnects or starts reconnecting.
 */
function installDiscordGatewayDiagnostics(client, { logger = console } = {}) {
  client.on(Events.ShardError, (error, shardId) => {
    logger.error(`[bot] Discord shard ${shardId} error:`, error);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn(
      `[bot] Discord shard ${shardId} disconnected (code ${event?.code ?? "unknown"}).`
    );
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    logger.warn(`[bot] Discord shard ${shardId} reconnecting...`);
  });
}

/**
 * Start Discord login with a hard readiness deadline. discord.js retries
 * gateway Hello/Ready timeouts internally, which can otherwise leave a
 * Railway container alive forever without ever emitting ClientReady.
 *
 * @returns {Promise<boolean>} true when login becomes ready, false after a
 * handled failure/timeout (the supplied terminator owns process shutdown).
 */
async function startDiscordLogin({
  client,
  token,
  terminate,
  timeoutMs = DISCORD_LOGIN_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Discord login timeout must be a positive number");
  }

  logger.log(
    `[bot] Connecting to Discord gateway (timeout ${Math.ceil(timeoutMs / 1000)}s)...`
  );

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutFn(
      () => reject(new DiscordLoginTimeoutError(timeoutMs)),
      timeoutMs
    );
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => client.login(token)),
      timeout,
    ]);
    return true;
  } catch (error) {
    const timedOut = error instanceof DiscordLoginTimeoutError;
    await terminate({
      label: timedOut
        ? `Discord login timed out after ${Math.ceil(timeoutMs / 1000)}s`
        : "Discord login failed",
      error: timedOut ? null : error,
      exitCode: 1,
    });
    return false;
  } finally {
    clearTimeoutFn(timer);
  }
}

module.exports = {
  DISCORD_LOGIN_TIMEOUT_MS,
  installDiscordGatewayDiagnostics,
  startDiscordLogin,
};
