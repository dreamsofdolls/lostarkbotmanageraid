/**
 * app/slash-command-registration.js
 * Boot-time slash-command registration with Discord's REST API. Lives
 * in app/ because it knows env + Discord wiring but owns no command
 * behavior. Failure is logged + non-fatal so the bot still starts when
 * env is partial (helps local dev without a GUILD_ID).
 */

"use strict";

const { REST, Routes } = require("discord.js");

/**
 * Register slash commands against Discord's REST API at boot time.
 * Silent skip when DISCORD_TOKEN or GUILD_ID is unset (local dev).
 * Errors are logged + swallowed so the bot continues coming up · the
 * Discord client still works without per-guild command refresh.
 * @param {object} opts
 * @param {object} opts.client - logged-in discord.js Client
 * @param {Array} opts.commands - SlashCommandBuilder[] (toJSON-able)
 * @param {string} [opts.guildId=process.env.GUILD_ID]
 * @param {string} [opts.token=process.env.DISCORD_TOKEN]
 * @param {object} [opts.log=console]
 * @returns {Promise<void>}
 */
async function registerSlashCommandsOnBoot({
  client,
  commands,
  guildId = process.env.GUILD_ID,
  token = process.env.DISCORD_TOKEN,
  log = console,
} = {}) {
  if (!guildId) {
    log.warn("[bot] GUILD_ID not set - skipping slash command registration on boot.");
    return;
  }
  if (!token) {
    log.warn("[bot] DISCORD_TOKEN not set - skipping slash command registration on boot.");
    return;
  }
  if (!client?.user?.id) {
    throw new Error("[bot] Discord client user is not ready for command registration.");
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const body = commands.map((command) => command.toJSON());
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body }
    );
    log.log(`[bot] Registered ${body.length} slash commands for guild ${guildId}.`);
  } catch (err) {
    log.error(
      "[bot] Failed to register slash commands (continuing anyway):",
      err?.message || err
    );
  }
}

module.exports = {
  registerSlashCommandsOnBoot,
};
