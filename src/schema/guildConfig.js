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
  },
  {
    timestamps: true,
  }
);

const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

module.exports = GuildConfig;
