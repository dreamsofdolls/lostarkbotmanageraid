/**
 * services/access/application-owner.js
 * Answers whether a user owns the bot's Discord application, as the
 * Developer Portal records it. A Team-owned app has a team id here, which
 * never equals a user id, so it is refused.
 */

"use strict";

/**
 * Check a user against the application owner, fetching the application once
 * when the owner is not loaded yet.
 * @param {import("discord.js").Client} client - logged-in client
 * @param {string} userId - Discord user id to check
 * @returns {Promise<boolean>} true only when the owner is that user; false on a failed fetch
 */
async function isApplicationOwner(client, userId) {
  const application = client?.application;
  if (!application) return false;
  try {
    if (!application.owner) await application.fetch();
  } catch (err) {
    console.warn(`[owner] Application fetch failed: ${err?.message || err}`);
    return false;
  }
  return application.owner?.id === userId;
}

module.exports = { isApplicationOwner };
