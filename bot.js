require("dotenv").config();

// TLS validation guard. NODE_TLS_REJECT_UNAUTHORIZED=0 disables Node's
// HTTPS certificate verification globally and exposes every outbound TLS
// call (Discord gateway/REST, MongoDB Atlas, lostark.bible) to MITM. The
// bot has no legitimate use case for it: every upstream serves a valid
// public cert. Refuse to start so the operator notices in deploy logs
// rather than running silently insecure for weeks.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.error(
    "[security] NODE_TLS_REJECT_UNAUTHORIZED=0 detected in environment. " +
      "This disables TLS certificate validation for ALL outbound HTTPS " +
      "(Discord, MongoDB, lostark.bible) and is a MITM hazard. Remove it " +
      "from your shell / Railway env vars before starting the bot."
  );
  process.exit(1);
}

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
} = require("discord.js");
const { connectDB } = require("./bot/db");
const {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidLanguageSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidTaskAutocomplete,
  handleRaidTaskButton,
  handleRaidAnnounceAutocomplete,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  handleAddRosterButton,
  handleEditRosterAutocomplete,
  handleEditRosterButton,
  handleRaidGoldEarnerAutocomplete,
  handleRaidGoldEarnerButton,
  handleStuckNudgeButton,
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startSideTaskResetScheduler,
  applyRaidSetForDiscordId,
} = require("./bot/commands");
const User = require("./bot/models/user");
const { startWeeklyResetJob } = require("./bot/services/raid/weekly-reset");
const { bootstrapClassEmoji, bootstrapArtistEmoji } = require("./bot/services/discord/emoji-bootstrap");
const { registerSlashCommandsOnBoot } = require("./bot/app/slash-command-registration");
const { startLocalSyncWebCompanion } = require("./bot/app/local-sync-web");
const { createRaidInteractionRouter } = require("./bot/app/interaction-router-registry");

const { DISCORD_TOKEN, GUILD_ID } = process.env;

// Deploy gate for the text-monitor feature. `MessageContent` is a privileged
// intent - if it's not enabled in the Discord Developer Portal, Discord
// rejects the login and the bot process exits. Setting TEXT_MONITOR_ENABLED=false
// lets a deployment run slash-command-only without the privileged intent.
const TEXT_MONITOR_ENABLED = process.env.TEXT_MONITOR_ENABLED !== "false";

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
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

  startLocalSyncWebCompanion({
    rootDir: __dirname,
    User,
    applyRaidSetForDiscordId,
  });

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
    await registerSlashCommandsOnBoot({
      client: readyClient,
      commands,
      guildId: GUILD_ID,
      token: DISCORD_TOKEN,
    });
    // Idempotent: lists existing application emoji, uploads only PNGs
    // that aren't already there. After the first deploy uploads the full
    // set, subsequent restarts are just one GET + skip (~500ms). Failure
    // is logged + swallowed - bot keeps running with whatever subset of
    // CLASS_EMOJI_MAP got populated; getClassEmoji falls back to empty
    // string for the rest so char fields just render without icons.
    bootstrapClassEmoji(readyClient).catch((err) =>
      console.warn("[bot] class-emoji bootstrap rejected (non-fatal):", err?.message || err)
    );
    // Artist persona emoji (assets/artist-icons/) - same content-hash
    // pattern as class-emoji, separate folder + map. Powers the chibi
    // Artist face in the pinned welcome embed and any future
    // bot-voice surfaces. Failure is also non-fatal: getArtistEmoji
    // falls back to empty string when an entry is unmapped.
    bootstrapArtistEmoji(readyClient).catch((err) =>
      console.warn("[bot] artist-emoji bootstrap rejected (non-fatal):", err?.message || err)
    );
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
    // Maintenance reminder scheduler. 1-min tick, hard-coded fire schedule
    // for LA VN Wednesday 14:00 maintenance boundary - 7 fire points total
    // (T-3h/2h/1h early reminders + T-15m/10m/5m/1m countdown). Per-guild
    // gating via /raid-announce type:maintenance-early|countdown action:on/off.
    // Tick is cheap on non-Wednesday days (early-exits before any DB query),
    // so leaving it running 24/7 has negligible cost.
    startMaintenanceScheduler(readyClient);
    // Side-task reset scheduler. 30-min tick, bulk updateMany. Resets
    // per-character side tasks once their cycle boundary passes (daily
    // 10:00 UTC = 17:00 VN, weekly Wed 10:00 UTC = 17:00 VN). Independent
    // of AUTO_MANAGE_DAILY_DISABLED so player-tracked chores never get
    // stuck "completed forever" even if bible auto-sync is off.
    startSideTaskResetScheduler();
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

  // Routing registry lives under bot/app so the entrypoint stays focused
  // on lifecycle and startup wiring.
  const router = createRaidInteractionRouter({
    MessageFlags,
    handlers: {
      handleRaidManagementCommand,
      handleRaidHelpSelect,
      handleRaidLanguageSelect,
      handleRaidSetAutocomplete,
      handleRemoveRosterAutocomplete,
      handleRaidChannelAutocomplete,
      handleRaidAutoManageAutocomplete,
      handleRaidTaskAutocomplete,
      handleRaidAnnounceAutocomplete,
      handleRaidCheckButton,
      handleAddRosterButton,
      handleEditRosterAutocomplete,
      handleEditRosterButton,
      handleRaidGoldEarnerAutocomplete,
      handleRaidGoldEarnerButton,
      handleRaidTaskButton,
      handleStuckNudgeButton,
    },
  });

  client.on(Events.InteractionCreate, router.handle);

  await client.login(DISCORD_TOKEN);
}

startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
