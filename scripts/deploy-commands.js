require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { commands } = require("../bot/commands");

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

function normalizeSnowflake(name, rawValue) {
  if (!rawValue) return null;

  const value = String(rawValue).trim().replace(/^['\"]|['\"]$/g, "");
  if (/^\d{17,20}$/.test(value)) return value;

  // Common mistake: pasting the full OAuth2 URL instead of plain client id.
  if (value.includes("discord.com/oauth2/authorize")) {
    try {
      const parsed = new URL(value);
      const extracted = parsed.searchParams.get("client_id");
      if (extracted && /^\d{17,20}$/.test(extracted)) {
        console.warn(`[warn] ${name} looked like an OAuth URL, extracted id automatically.`);
        return extracted;
      }
    } catch {
      // Ignore URL parse failures and continue to error below.
    }
  }

  throw new Error(
    `${name} is invalid. Expected a numeric Discord ID (17-20 digits), got: ${value}`
  );
}

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
  process.exit(1);
}

const normalizedClientId = normalizeSnowflake("CLIENT_ID", CLIENT_ID);
const normalizedGuildId = normalizeSnowflake("GUILD_ID", GUILD_ID);

const slashCommands = commands.map((command) => command.toJSON());
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Refreshing application (/) commands...");
    await rest.put(Routes.applicationGuildCommands(normalizedClientId, normalizedGuildId), {
      body: slashCommands,
    });
    console.log("Slash commands registered successfully.");
    // Force clean exit: discord.js REST client keeps a keep-alive HTTP agent
    // alive which prevents natural event-loop drain. Without explicit exit(0)
    // the Railway `&& node bot.js` chain hangs forever and the bot never
    // starts - leaving DB disconnected and the bot offline.
    process.exit(0);
  } catch (error) {
    if (error?.status === 404) {
      console.error(
        "Discord returned 404. Check that CLIENT_ID is from General Information, GUILD_ID is your server ID, and the bot is invited to that server."
      );
    }
    console.error(error);
    process.exit(1);
  }
})();
