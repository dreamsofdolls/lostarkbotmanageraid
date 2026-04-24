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
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidAnnounceAutocomplete,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
} = require("./raid-command");
const { startWeeklyResetJob } = require("./weekly-reset");

const { DISCORD_TOKEN, GUILD_ID } = process.env;

// Deploy gate for the text-monitor feature. `MessageContent` is a privileged
// intent - if it's not enabled in the Discord Developer Portal, Discord
// rejects the login and the bot process exits. Setting TEXT_MONITOR_ENABLED=false
// lets a deployment run slash-command-only without the privileged intent.
const TEXT_MONITOR_ENABLED = process.env.TEXT_MONITOR_ENABLED !== "false";

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

function describeInteraction(interaction) {
  if (!interaction) return "unknown";
  if (interaction.isChatInputCommand?.()) return `command=${interaction.commandName}`;
  if (interaction.isAutocomplete?.()) return `autocomplete=${interaction.commandName}`;
  if (interaction.customId) return `customId=${interaction.customId}`;
  return `type=${interaction.type || "unknown"}`;
}

function getInteractionAgeMs(interaction) {
  const created = Number(interaction?.createdTimestamp) || 0;
  return created > 0 ? Date.now() - created : null;
}

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

/**
 * Register every slash command in `commands[]` with Discord at boot time,
 * scoped to GUILD_ID. This mirrors the pattern in the sibling LostArk_LoaLogs
 * bot so a Railway redeploy alone is enough to push schema changes - no
 * separate `npm run deploy:commands` step required.
 *
 * Failures are logged and swallowed: the bot keeps running with whatever
 * schema Discord currently has cached, so a transient Discord API outage
 * cannot take the bot offline.
 */
async function registerSlashCommandsOnBoot(client) {
  if (!GUILD_ID) {
    console.warn("[bot] GUILD_ID not set - skipping slash command registration on boot.");
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

  // Warm the monitor channel cache BEFORE Discord login. The cache is pure
  // DB data - no client dependency - and loading it inside `ClientReady`
  // creates a race: `MessageCreate` fires on the first message after login,
  // potentially before the ready handler finishes, and an empty cache on
  // the hot path drops that message as "no monitor configured."
  //
  // Load regardless of TEXT_MONITOR_ENABLED - even when the monitor is
  // deploy-disabled, /raid-channel config action:show needs to reflect any
  // persisted raidChannelId so admins see stale config clearly instead of
  // an empty-looking cache that masquerades as "chưa config channel nào".
  await loadMonitorChannelCache();

  const intents = [GatewayIntentBits.Guilds];
  if (TEXT_MONITOR_ENABLED) {
    // GuildMessages + MessageContent power the raid-channel text monitor.
    // MessageContent is a privileged intent - it must be enabled in the
    // Discord Developer Portal (Bot → Privileged Gateway Intents) or the
    // login will fail with "Used disallowed intents".
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  } else {
    console.log("[bot] TEXT_MONITOR_ENABLED=false - skipping MessageContent intent and MessageCreate listener.");
  }

  const client = new Client({ intents });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    await registerSlashCommandsOnBoot(readyClient);
    // Daily auto-cleanup scheduler for raid monitor channels. Runs always -
    // per-guild `autoCleanupEnabled` flag gates whether a given guild
    // actually does anything. Independent of TEXT_MONITOR_ENABLED so
    // admins can schedule cleanups even when the text monitor is off.
    startRaidChannelScheduler(readyClient);
    // Weekly raid reset: must run inside ClientReady (not earlier at
    // connectDB time) because the tick posts per-guild announcements via
    // the Discord client. Catch-up ticks dedup per guild via
    // `lastWeeklyAnnouncementKey` so a bot restart inside the same ISO
    // week won't re-announce.
    startWeeklyResetJob(readyClient);
    // Phase 3: 24h passive auto-sync scheduler for /raid-auto-manage
    // opted-in users. 30-min tick, 3-user batch, per-user cooldown gated.
    // Killswitch: AUTO_MANAGE_DAILY_DISABLED=true env var skips every tick
    // - useful if bible starts blocking and ops need to back off without
    // a redeploy. Accepts client ref so the tick can post channel
    // announcements when it detects a stuck private-log user.
    startAutoManageDailyScheduler(readyClient);
  });

  if (TEXT_MONITOR_ENABLED) {
    client.on(Events.MessageCreate, async (message) => {
      try {
        await handleRaidChannelMessage(message);
      } catch (error) {
        console.error("[bot] raid-channel message handler error:", error);
      }
    });
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const allowed = ["add-roster", "raid-check", "raid-set", "raid-status", "raid-help", "remove-roster", "raid-channel", "raid-auto-manage", "raid-announce"];
        if (!allowed.includes(interaction.commandName)) return;
        await handleRaidManagementCommand(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "raid-set") {
          await handleRaidSetAutocomplete(interaction);
        } else if (interaction.commandName === "remove-roster") {
          await handleRemoveRosterAutocomplete(interaction);
        } else if (interaction.commandName === "raid-channel") {
          await handleRaidChannelAutocomplete(interaction);
        } else if (interaction.commandName === "raid-auto-manage") {
          await handleRaidAutoManageAutocomplete(interaction);
        } else if (interaction.commandName === "raid-announce") {
          await handleRaidAnnounceAutocomplete(interaction);
        } else {
          await interaction.respond([]).catch(() => {});
        }
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === "raid-help:select") {
        await handleRaidHelpSelect(interaction);
        return;
      }

      // Phase 2 /raid-check interactive buttons. Custom IDs follow the
      // shape "raid-check:<action>:<raidKey>" - dispatcher handles auth +
      // action routing, no per-button switch here.
      if (interaction.isButton() && interaction.customId.startsWith("raid-check:")) {
        await handleRaidCheckButton(interaction);
        return;
      }
    } catch (error) {
      if (isUnknownInteractionError(error)) {
        const ageMs = getInteractionAgeMs(interaction);
        const agePart = ageMs === null ? "" : ` ageMs=${ageMs}`;
        console.warn(
          `[bot] stale interaction ignored: ${describeInteraction(interaction)}${agePart}`
        );
        return;
      }

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
