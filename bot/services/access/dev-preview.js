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

const {
  parseEnvAllowlistIds,
  createEnvAllowlistChecker,
} = require("./env-allowlist");

function parseDevUserIds(rawEnvValue) {
  return parseEnvAllowlistIds(rawEnvValue, { envName: "DEV_USER" });
}

const DEV_USER_IDS = parseDevUserIds();
const isDevUserId = createEnvAllowlistChecker(DEV_USER_IDS);

/**
 * Whether a Discord user is in the dev-preview allowlist (DEV_USER env).
 * @param {string} discordId - Discord user ID to check
 * @returns {boolean} true only if the id is explicitly allowlisted
 */
function isDevUser(discordId) {
  return isDevUserId(discordId);
}

module.exports = {
  DEV_USER_IDS,
  isDevUser,
  parseDevUserIds,
};
