const mongoose = require("mongoose");

const guildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    // Per-guild language code for PUBLIC announcement bodies (welcome embed,
    // weekly-reset / cleanup / bedtime / wakeup / maintenance / stuck-nudge
    // notices, text-parser whisper ack and raid-update reply embeds, etc).
    // These broadcasts have no single per-user "viewer" so they can't use
    // per-user `User.language`. Default "vi" matches the legacy behavior
    // when this field doesn't exist on a doc - getGuildLanguage falls back
    // to "vi" on missing/null. JP/EN guilds opt in via /raid-channel config
    // action:set-language. Free-text on the schema (validated at action
    // boundary) so adding a new locale doesn't require a schema migration.
    language: { type: String, default: "vi" },
    // Channel ID the bot monitors for short-text raid-clear messages.
    // null/empty = monitor disabled for this guild.
    raidChannelId: { type: String, default: null },
    // Channel where /raid-bg set rehosts uploaded background images. Bot
    // needs Send Messages + Attach Files there. null/empty = /raid-bg
    // set rejects with a "ask admin to /raid-channel config action:set-bg-channel"
    // alert, and /raid-status keeps rendering the existing text embed
    // for everyone in this guild (no behavior change from pre-feature).
    // Set via /raid-channel config action:set-bg-channel channel:#... ·
    // mirrors the raidChannelId set flow so admins discover both knobs
    // under the same command.
    raidBgChannelId: { type: String, default: null },
    // Toggle for the daily auto-cleanup job. When true, the scheduler
    // deletes every non-pinned message in `raidChannelId` right after
    // the VN-day boundary (00:00 Asia/Ho_Chi_Minh = 17:00 UTC).
    autoCleanupEnabled: { type: Boolean, default: false },
    // Idempotency cursor - "YYYY-MM-DD" in VN calendar. Set to the target
    // day's key after a successful cleanup so the next tick in the same
    // VN day short-circuits. Missed days (bot offline) catch up on the
    // next tick regardless of day of week.
    lastAutoCleanupKey: { type: String, default: null },
    // Discord message ID of the pinned welcome embed this bot posted in
    // the monitor channel. Stored so `/raid-channel config action:repin`
    // can unpin the exact stored message instead of scanning every
    // bot-authored pin (which would remove unrelated bot pins).
    welcomeMessageId: { type: String, default: null },
    // Per-guild dedup for the weekly reset announcement. Set to the target
    // ISO week key (e.g. "2026-W17") once the post-reset announcement has
    // been posted in this guild's monitor channel. Subsequent weekly-reset
    // ticks within the same ISO week short-circuit; crossing into the next
    // ISO week produces a new key and the next tick posts again.
    lastWeeklyAnnouncementKey: { type: String, default: null },
    // Per-guild dedup for Artist's daily bedtime moment. `YYYY-MM-DD` in VN
    // calendar. Set once the 3:00 VN quiet-hours greeting has been posted
    // today; subsequent quiet-hours ticks skip the announcement AND the
    // cleanup sweep. Rolls over each VN calendar day so the next bedtime
    // fires fresh.
    lastArtistBedtimeKey: { type: String, default: null },
    // Per-guild dedup for Artist's daily wake-up + morning-sweep moment.
    // `YYYY-MM-DD` in VN calendar. Set once the 8:00 VN wake-up embed +
    // catch-up cleanup have both run today. Subsequent ticks that day fall
    // through to the normal hourly-cleanup path.
    lastArtistWakeupKey: { type: String, default: null },
    // Per-guild dedup for the maintenance-early reminder group (T-3h, T-2h,
    // T-1h marks). Format: `YYYY-MM-DD:<slotKey>` where slotKey is one of
    // "T-3h", "T-2h", "T-1h". Set after a successful post for that slot.
    // The maintenance scheduler short-circuits when the current target slot
    // matches the stored key. Different group keys are tracked separately
    // so an early group failure never blocks the countdown group.
    lastMaintenanceEarlyKey: { type: String, default: null },
    // Per-guild dedup for the maintenance-countdown reminder group (T-15m,
    // T-10m, T-5m, T-1m). Same shape as `lastMaintenanceEarlyKey` but the
    // slotKey set is "T-15m" / "T-10m" / "T-5m" / "T-1m".
    lastMaintenanceCountdownKey: { type: String, default: null },
    // Per-announcement-type config for Artist's channel voice. Each nested
    // subdoc has:
    //   - enabled: whether the announcement fires at all.
    //   - channelId: override destination (null = fallback to raidChannelId).
    //       Only subdocs with a channelId field accept overrides; channel-bound
    //       types omit it and always fire into the raid monitor channel.
    // Defaults all enabled=true / channelId=null so legacy guilds that
    // existed before this field landed get the full voice out of the box.
    announcements: {
      type: new mongoose.Schema(
        {
          weeklyReset: {
            type: new mongoose.Schema(
              {
                enabled: { type: Boolean, default: true },
                channelId: { type: String, default: null },
              },
              { _id: false }
            ),
            default: () => ({}),
          },
          stuckPrivateLogNudge: {
            type: new mongoose.Schema(
              {
                enabled: { type: Boolean, default: true },
                channelId: { type: String, default: null },
              },
              { _id: false }
            ),
            default: () => ({}),
          },
          setGreeting: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
              { _id: false }
            ),
            default: () => ({}),
          },
          hourlyCleanupNotice: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
              { _id: false }
            ),
            default: () => ({}),
          },
          // Artist's 3:00 VN bedtime greeting. Channel-bound (like the
          // hourly cleanup notice) because the message refers to the
          // monitor channel itself going quiet. Disable = bedtime skipped
          // silently, quiet-hours behavior (no cleanup sweep) still applies.
          artistBedtime: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
              { _id: false }
            ),
            default: () => ({}),
          },
          // Artist's 8:00 VN wake-up + morning-sweep notice. Channel-bound
          // for the same reason. Disable = the wake-up greeting text is
          // skipped; the catch-up cleanup sweep still runs because skipping
          // it would leave overnight messages piled until the first :00 or
          // :30 tick after 8:00.
          artistWakeup: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
              { _id: false }
            ),
            default: () => ({}),
          },
          whisperAck: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
              { _id: false }
            ),
            default: () => ({}),
          },
          // Maintenance early reminders (T-3h / T-2h / T-1h marks). Channel-
          // overridable: a server can push these to a different channel from
          // the monitor channel to avoid pinging in the same place as
          // clear-raid notifications. Toggle group is independent of
          // maintenanceCountdown.
          maintenanceEarly: {
            type: new mongoose.Schema(
              {
                enabled: { type: Boolean, default: true },
                channelId: { type: String, default: null },
              },
              { _id: false }
            ),
            default: () => ({}),
          },
          // Maintenance countdown reminders (T-15m / T-10m / T-5m / T-1m).
          // Same channel-override model as maintenanceEarly. Split into a
          // separate group so a server that doesn't want 4 consecutive
          // pings near the boundary can disable just this group while
          // keeping the 3 earlier reminders.
          maintenanceCountdown: {
            type: new mongoose.Schema(
              {
                enabled: { type: Boolean, default: true },
                channelId: { type: String, default: null },
              },
              { _id: false }
            ),
            default: () => ({}),
          },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

module.exports = GuildConfig;
