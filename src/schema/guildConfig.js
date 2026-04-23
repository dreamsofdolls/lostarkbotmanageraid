const mongoose = require("mongoose");

const guildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    // Channel ID the bot monitors for short-text raid-clear messages.
    // null/empty = monitor disabled for this guild.
    raidChannelId: { type: String, default: null },
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
    // Per-announcement-type config for Artist's channel voice. Each nested
    // subdoc has:
    //   - enabled: whether the announcement fires at all.
    //   - channelId: override destination (null = fallback to raidChannelId).
    //       Only weekly-reset and stuck-nudge accept overrides; the other
    //       three types are channel-bound by semantics (greeting/cleanup
    //       notice/whisper ack all refer to the raid monitor channel
    //       itself) so their channelId is ignored by the firing site.
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
          whisperAck: {
            type: new mongoose.Schema(
              { enabled: { type: Boolean, default: true } },
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
