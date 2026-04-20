/**
 * config.js
 * Loads and validates all environment variables from .env file.
 * Centralizes configuration so no sensitive data is hardcoded.
 */

// dotenv.config() is safe to call in all environments:
// - Locally: loads vars from .env file
// - On Railway: .env doesn't exist in the container, so this is a no-op.
//   Railway-injected vars in process.env are NEVER overridden by dotenv.
import dotenv from 'dotenv';
dotenv.config();

/**
 * Validate all required environment variables up-front.
 * Logs every missing key and exits cleanly so Railway shows a clear error.
 * @param {string[]} keys
 */
function validateEnv(keys) {
  // Debug: print which vars are present (names only, never values)
  console.log('[config] NODE_ENV:', process.env.NODE_ENV ?? '(not set)');
  console.log('[config] Env vars present:', keys.map((k) => `${k}=${process.env[k] ? '✓' : '✗'}`).join(', '));

  const missing = keys.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    console.error('[config] Missing required environment variables:');
    missing.forEach((k) => console.error(`  - ${k}`));
    console.error('[config] Set these in the Railway Variables tab and redeploy.');
    process.exit(1);
  }
}

/**
 * Get a required environment variable (assumed already validated).
 * @param {string} key
 * @returns {string}
 */
function requireEnv(key) {
  return process.env[key].trim();
}

validateEnv(['DISCORD_TOKEN', 'CHANNEL_ID', 'MONGODB_URI']);

/**
 * Parse CHECK_INTERVAL from env (in seconds), fallback to 30s.
 * Enforces a minimum of 10 seconds to avoid hammering the server.
 */
function parseInterval() {
  const raw = parseInt(process.env.CHECK_INTERVAL, 10);
  if (isNaN(raw) || raw < 10) {
    console.warn('[config] CHECK_INTERVAL not set or too low – defaulting to 30 seconds.');
    return 30_000;
  }
  return raw * 1000; // convert to milliseconds
}

const config = {
  /** Discord bot token */
  token: requireEnv('DISCORD_TOKEN'),

  /** ID of the channel where notifications are sent */
  channelId: requireEnv('CHANNEL_ID'),

  /** ID of the role to mention in notifications */
  // roleId: requireEnv('ROLE_ID'),

  /** How often to check server status (milliseconds) */
  checkIntervalMs: parseInterval(),

  /** MongoDB connection string */
  mongoUri: requireEnv('MONGODB_URI'),

  /** ScraperAPI keys (fallback chain) — SCRAPERAPI_KEY, SCRAPERAPI_KEY_2, SCRAPERAPI_KEY_3... */
  scraperApiKeys: [
    process.env.SCRAPERAPI_KEY,
    process.env.SCRAPERAPI_KEY_2,
    process.env.SCRAPERAPI_KEY_3,
  ]
    .map((k) => (k || '').trim())
    .filter(Boolean),

  /** @deprecated — use scraperApiKeys[0] instead (kept for backward compat) */
  get scraperApiKey() { return this.scraperApiKeys[0] || ''; },

  /** Approver IDs for /list add approval flow (comma-separated Discord user IDs) */
  officerApproverIds: (process.env.OFFICER_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  seniorApproverIds: (process.env.SENIOR_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  memberApproverIds: (process.env.MEMBER_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /** Optional channel IDs to broadcast list add/remove notifications (comma-separated) */
  listNotifyChannelIds: (process.env.LIST_NOTIFY_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Optional channel IDs for auto-checking screenshots (comma-separated) */
  autoCheckChannelIds: (process.env.AUTO_CHECK_CHANNEL_IDS || process.env.AUTO_CHECK_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Owner guild ID — this server can view all server-scoped blacklist entries from every guild */
  ownerGuildId: (process.env.OWNER_GUILD_ID || '').trim(),

  /** Optional Gemini API key for image-based /listcheck name extraction */
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),

  /** Gemini model priority list for image parsing with auto-failover on quota limits */
  geminiModels: (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.1-flash-lite-preview,gemini-3-flash-preview')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
};

export default config;
