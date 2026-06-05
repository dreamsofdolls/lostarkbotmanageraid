"use strict";

function stripTokenQuotes(value) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "");
}

function parseEnvAllowlistIds(rawEnvValue, options = {}) {
  const envName = options.envName || "";
  const raw =
    typeof rawEnvValue === "string"
      ? rawEnvValue
      : envName
        ? process.env[envName] || ""
        : "";

  return new Set(
    raw
      .split(/[\s,]+/)
      .map(stripTokenQuotes)
      .filter(Boolean),
  );
}

function createEnvAllowlistChecker(ids) {
  const allowlist = ids instanceof Set ? ids : new Set();
  return function isAllowlisted(discordId) {
    if (!discordId) return false;
    return allowlist.has(String(discordId));
  };
}

module.exports = {
  parseEnvAllowlistIds,
  createEnvAllowlistChecker,
};
