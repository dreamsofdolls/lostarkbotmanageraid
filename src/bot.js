require("dotenv").config();

const { Client, GatewayIntentBits, Events } = require("discord.js");
const { connectDB } = require("../db");
const { handleRaidManagementCommand, handleRaidHelpSelect } = require("./raid-command");
const { startWeeklyResetJob } = require("./weekly-reset");

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

async function startBot() {
  await connectDB();
  startWeeklyResetJob();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const allowed = ["add-roster", "raid-check", "raid-set", "raid-status", "raid-help"];
        if (!allowed.includes(interaction.commandName)) return;
        await handleRaidManagementCommand(interaction);
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
        ephemeral: true,
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