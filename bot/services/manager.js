// Raid-manager allowlist helper. Single source of truth for who counts as a
// "manager" across the bot. Previously each caller parsed process.env.RAID_MANAGER_ID
// on its own, which made it hard to extend the allowlist with additional
// privileges (shorter sync cooldown, on-roster visual tag, etc) without
// scattering the same comma-split-and-trim logic everywhere.
//
// Why env-over-Mongo: keeps operator rotation identical to the pre-existing
// /raid-check gate (update Railway env + redeploy) instead of fragmenting
// privilege config across env + DB. Consistent with AUTO_MANAGE_DAILY_DISABLED
// and other boot-time toggles.

const DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
const MANAGER_AUTO_MANAGE_SYNC_COOLDOWN_MS = 15 * 1000;

// Roster metadata refresh cooldown (iLvl/class scrape from lostark.bible).
// Regular users keep the conservative 2h spacing so we don't hammer bible
// when a roster sits in a /raid-status embed for a long browse session.
// Managers (RAID_MANAGER_ID allowlist) drop to 10 minutes so they can
// trigger a fresh scrape during operational decisions (rolling raids,
// verifying iLvl just before invites) without waiting hours. Mirrors the
// existing manager privilege on /raid-auto-manage sync (15s vs 10m).
const DEFAULT_ROSTER_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MANAGER_ROSTER_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

function parseManagerIds(rawEnvValue) {
  const raw = typeof rawEnvValue === "string" ? rawEnvValue : (process.env.RAID_MANAGER_ID || "");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const MANAGER_IDS = parseManagerIds();

function isManagerId(discordId) {
  if (!discordId) return false;
  return MANAGER_IDS.has(String(discordId));
}

function getAutoManageCooldownMs(discordId) {
  return isManagerId(discordId)
    ? MANAGER_AUTO_MANAGE_SYNC_COOLDOWN_MS
    : DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS;
}

function getRosterRefreshCooldownMs(discordId) {
  return isManagerId(discordId)
    ? MANAGER_ROSTER_REFRESH_COOLDOWN_MS
    : DEFAULT_ROSTER_REFRESH_COOLDOWN_MS;
}

// First entry in the allowlist — used as the "primary admin to ping"
// in error embeds so users see a clickable @mention instead of a
// generic "ping admin" message. Returns null when no managers are
// configured (env unset / empty), which lets call sites fall back to
// the generic copy gracefully.
function getPrimaryManagerId() {
  for (const id of MANAGER_IDS) return id;
  return null;
}

module.exports = {
  MANAGER_IDS,
  isManagerId,
  getAutoManageCooldownMs,
  getRosterRefreshCooldownMs,
  getPrimaryManagerId,
  parseManagerIds,
  DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  MANAGER_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  DEFAULT_ROSTER_REFRESH_COOLDOWN_MS,
  MANAGER_ROSTER_REFRESH_COOLDOWN_MS,
};
