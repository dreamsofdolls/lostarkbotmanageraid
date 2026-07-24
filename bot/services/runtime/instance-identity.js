"use strict";

const MAX_RUNTIME_VALUE_LENGTH = 96;

function sanitizeRuntimeValue(value, fallback = "local") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .slice(0, MAX_RUNTIME_VALUE_LENGTH);
  return normalized || fallback;
}

/**
 * Build a secret-free process fingerprint for correlating Railway logs.
 * @param {{env?: NodeJS.ProcessEnv, pid?: number}} [options]
 * @returns {string} stable key-value fields suitable for one-line logs
 */
function buildRuntimeInstanceIdentity({
  env = process.env,
  pid = process.pid,
} = {}) {
  const service = sanitizeRuntimeValue(
    env.RAILWAY_SERVICE_NAME || env.RAILWAY_SERVICE_ID
  );
  const environment = sanitizeRuntimeValue(
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID
  );
  const deployment = sanitizeRuntimeValue(env.RAILWAY_DEPLOYMENT_ID);
  const replica = sanitizeRuntimeValue(
    env.RAILWAY_REPLICA_ID || env.HOSTNAME
  );
  const processId = sanitizeRuntimeValue(pid, "unknown");

  return [
    `service=${service}`,
    `environment=${environment}`,
    `deployment=${deployment}`,
    `replica=${replica}`,
    `pid=${processId}`,
  ].join(" ");
}

module.exports = {
  buildRuntimeInstanceIdentity,
};
