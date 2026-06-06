"use strict";

function createRaidChannelScheduleActions({
  EmbedBuilder,
  UI,
  GuildConfig,
  getCachedMonitorChannelId,
  getTargetCleanupSlotKey,
  t,
}) {
  async function isAlreadyInRequestedState(guildId, enabled) {
    try {
      const cfg = await GuildConfig.findOne({ guildId }).lean();
      return Boolean(cfg && !!cfg.autoCleanupEnabled === enabled);
    } catch (err) {
      console.warn("[raid-channel] schedule no-op check failed:", err?.message || err);
      return false;
    }
  }

  async function handleScheduleToggle({ action, guildId, lang, replyChannelEmbed, replyChannelNotice }) {
    const enabled = action === "schedule-on";
    if (await isAlreadyInRequestedState(guildId, enabled)) {
      await replyChannelNotice({
        type: "info",
        title: t("raid-channel.schedule.noopTitle", lang),
        description: t(
          enabled
            ? "raid-channel.schedule.noopDescriptionOn"
            : "raid-channel.schedule.noopDescriptionOff",
          lang
        ),
      });
      return;
    }

    if (enabled && !getCachedMonitorChannelId(guildId)) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel.schedule.noChannelTitle", lang),
        description: t("raid-channel.schedule.noChannelDescription", lang),
      });
      return;
    }

    const update = enabled
      ? { $set: { autoCleanupEnabled: true, lastAutoCleanupKey: getTargetCleanupSlotKey() } }
      : { $set: { autoCleanupEnabled: false } };
    await GuildConfig.findOneAndUpdate(
      { guildId },
      update,
      { upsert: true, setDefaultsOnInsert: true }
    );

    const embed = new EmbedBuilder()
      .setColor(enabled ? UI.colors.success : UI.colors.muted)
      .setTitle(
        `${enabled ? UI.icons.done : UI.icons.reset} ${t(
          enabled
            ? "raid-channel.schedule.enabledTitle"
            : "raid-channel.schedule.disabledTitle",
          lang
        )}`
      )
      .setDescription(
        t(
          enabled
            ? "raid-channel.schedule.enabledDescription"
            : "raid-channel.schedule.disabledDescription",
          lang
        )
      )
      .setTimestamp();
    await replyChannelEmbed(embed);
  }

  return {
    handleScheduleToggle,
  };
}

module.exports = {
  createRaidChannelScheduleActions,
};
