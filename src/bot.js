require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  REST,
  Routes,
} = require("discord.js");
const { connectDB } = require("../db");
const {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
} = require("./raid-command");
const { startWeeklyResetJob } = require("./weekly-reset");

const { DISCORD_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

/**
 * Register every slash command in `commands[]` with Discord at boot time,
 * scoped to GUILD_ID. This mirrors the pattern in the sibling LostArk_LoaLogs
 * bot so a Railway redeploy alone is enough to push schema changes — no
 * separate `npm run deploy:commands` step required.
 *
 * Failures are logged and swallowed: the bot keeps running with whatever
 * schema Discord currently has cached, so a transient Discord API outage
 * cannot take the bot offline.
 */
async function registerSlashCommandsOnBoot(client) {
  if (!GUILD_ID) {
    console.warn("[bot] GUILD_ID not set — skipping slash command registration on boot.");
    return;
  }
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const body = commands.map((c) => c.toJSON());
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body }
    );
    console.log(`[bot] Registered ${body.length} slash commands for guild ${GUILD_ID}.`);
  } catch (err) {
    console.error(
      "[bot] Failed to register slash commands (continuing anyway):",
      err?.message || err
    );
  }
}

async function startBot() {
  await connectDB();
  startWeeklyResetJob();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    await registerSlashCommandsOnBoot(readyClient);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const allowed = ["add-roster", "raid-check", "raid-set", "raid-status", "raid-help", "remove-roster"];
        if (!allowed.includes(interaction.commandName)) return;
        await handleRaidManagementCommand(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "raid-set") {
          await handleRaidSetAutocomplete(interaction);
        } else if (interaction.commandName === "remove-roster") {
          await handleRemoveRosterAutocomplete(interaction);
        } else {
          await interaction.respond([]).catch(() => {});
        }
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === "raid-help:select") {
        await handleRaidHelpSelect(interaction);
        return;
      }
    } catch (error) {
      console.error("[bot] interaction error:", error);

      const payload = {
        content: "Có lỗi xảy ra khi xử lý lệnh. Vui lòng thử lại.",
        flags: MessageFlags.Ephemeral,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else if (interaction.isRepliable?.()) {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  await client.login(DISCORD_TOKEN);
}

startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});