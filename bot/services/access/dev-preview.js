// Dev-preview allowlist helper. Single source of truth for who may use
// preview-gated features (currently the whole /raid-profile surface) before
// general rollout. Operator sets DEV_USER as a comma/space-separated list of
// Discord user IDs - mirrors the RAID_MANAGER_ID convention (see
// services/access/manager.js).
//
// Intentionally NOT documented in env.example: this is a temporary preview
// gate, not standing config. Fail-closed: empty/unset DEV_USER = nobody is in
// the preview = every gated surface rejects, matching RAID_MANAGER_ID.
"use strict";

function parseDevUserIds(rawEnvValue) {
  const raw = typeof rawEnvValue === "string" ? rawEnvValue : (process.env.DEV_USER || "");
  return new Set(
    raw
      .split(/[\s,]+/)
      // Strip surrounding quotes per token: a `.env` value like
      // DEV_USER="123,456" may reach us still quoted depending on the loader.
      .map((s) => s.trim().replace(/^["']+|["']+$/g, ""))
      .filter(Boolean)
  );
}

const DEV_USER_IDS = parseDevUserIds();

/**
 * Whether a Discord user is in the dev-preview allowlist (DEV_USER env).
 * @param {string} discordId - Discord user ID to check
 * @returns {boolean} true only if the id is explicitly allowlisted
 */
function isDevUser(discordId) {
  if (!discordId) return false;
  return DEV_USER_IDS.has(String(discordId));
}

module.exports = {
  DEV_USER_IDS,
  isDevUser,
  parseDevUserIds,
};
