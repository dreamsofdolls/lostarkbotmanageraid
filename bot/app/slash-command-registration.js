"use strict";

const { REST, Routes } = require("discord.js");

/**
 * Register slash commands at boot. Kept in app/ because this is deployment
 * wiring: it knows Discord REST + env inputs, but owns no command behavior.
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
