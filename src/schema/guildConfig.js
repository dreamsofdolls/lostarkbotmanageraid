const mongoose = require("mongoose");

const guildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    // Channel ID the bot monitors for short-text raid-clear messages.
    // null/empty = monitor disabled for this guild.
    raidChannelId: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

module.exports = GuildConfig;
