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
  REST,
  Routes,
} = require("discord.js");
const { connectDB } = require("./bot/db");
const {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
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
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startSideTaskResetScheduler,
} = require("./bot/commands");
const { startWeeklyResetJob } = require("./bot/services/weekly-reset");
const { bootstrapClassEmoji, bootstrapArtistEmoji } = require("./bot/services/emoji-bootstrap");
const { createInteractionRouter } = require("./bot/services/interaction-router");

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

  // Routing extracted to ./services/interaction-router.js. Adding a new
  // command / autocomplete / button / select means updating one of the
  // registry props below; bot.js stays focused on lifecycle.
  const router = createInteractionRouter({
    MessageFlags,
    allowedCommands: [
      "add-roster",
      "edit-roster",
      "raid-check",
      "raid-set",
      "raid-status",
      "raid-help",
      "remove-roster",
      "raid-channel",
      "raid-auto-manage",
      "raid-announce",
      "raid-task",
      "raid-gold-earner",
      "raid-share",
    ],
    handleSlashCommand: handleRaidManagementCommand,
    autocompleteHandlers: {
      "raid-set": handleRaidSetAutocomplete,
      "edit-roster": handleEditRosterAutocomplete,
      "remove-roster": handleRemoveRosterAutocomplete,
      "raid-channel": handleRaidChannelAutocomplete,
      "raid-auto-manage": handleRaidAutoManageAutocomplete,
      "raid-announce": handleRaidAnnounceAutocomplete,
      "raid-task": handleRaidTaskAutocomplete,
      "raid-gold-earner": handleRaidGoldEarnerAutocomplete,
    },
    selectHandlers: {},
    selectRoutes: [
      // /raid-help dropdown customId carries the user's chosen language
      // suffix: `raid-help:select:<lang>`. Prefix-routing lets the
      // single handler dispatch all language variants.
      { prefix: "raid-help:select:", handle: handleRaidHelpSelect },
    ],
    buttonRoutes: [
      // Phase 2 /raid-check interactive buttons. Custom IDs follow the
      // shape "raid-check:<action>:<raidKey>" - dispatcher handles auth
      // + action routing, no per-button switch here.
      { prefix: "raid-check:", handle: handleRaidCheckButton },
      // /add-roster picker buttons: confirm / cancel / toggle (per-char).
      // CustomId: "add-roster:<action>:<sessionId>[:<charIndex>]".
      { prefix: "add-roster:", handle: handleAddRosterButton },
      // /edit-roster mirrors the /add-roster button shape.
      { prefix: "edit-roster:", handle: handleEditRosterButton },
      // /raid-task clear-confirm + clear-cancel buttons. CustomIds:
      // "raid-task:clear-confirm:<encoded-charname>" or "raid-task:clear-cancel".
      { prefix: "raid-task:", handle: handleRaidTaskButton },
      // /raid-gold-earner picker buttons: toggle / confirm / cancel.
      // CustomId: "gold-earner:<action>:<sessionId>[:<charIndex>]".
      { prefix: "gold-earner:", handle: handleRaidGoldEarnerButton },
    ],
  });

  client.on(Events.InteractionCreate, router.handle);

  await client.login(DISCORD_TOKEN);
}

startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
