"use strict";

const { NoticeKind, buildNoticeEmbed } = require("../../../utils/raid/common/shared");

// The result card per requested state.
const SCHEDULE_RESULTS = Object.freeze({
  on: {
    title: "raid-channel.schedule.enabledTitle",
    description: "raid-channel.schedule.enabledDescription",
    tip: "raid-channel.schedule.enabledTip",
    noop: "raid-channel.schedule.noopDescriptionOn",
  },
  off: {
    title: "raid-channel.schedule.disabledTitle",
    description: "raid-channel.schedule.disabledDescription",
    tip: "raid-channel.schedule.disabledTip",
    noop: "raid-channel.schedule.noopDescriptionOff",
  },
});

function createRaidChannelScheduleActions({
  EmbedBuilder,
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
    const result = SCHEDULE_RESULTS[enabled ? "on" : "off"];
    if (await isAlreadyInRequestedState(guildId, enabled)) {
      await replyChannelNotice({
        kind: NoticeKind.INPUT,
        title: t("raid-channel.schedule.noopTitle", lang),
        description: t(result.noop, lang),
        tip: t("raid-channel.schedule.noopTip", lang),
      });
      return;
    }

    if (enabled && !getCachedMonitorChannelId(guildId)) {
      await replyChannelNotice({
        kind: NoticeKind.EMPTY,
        title: t("raid-channel.noChannelTitle", lang),
        description: t("raid-channel.noChannelDescription", lang),
        tip: t("raid-channel.noChannelTip", lang),
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

    await replyChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.DONE,
      title: t(result.title, lang),
      description: t(result.description, lang),
      tip: t(result.tip, lang),
    }));
  }

  return {
    handleScheduleToggle,
  };
}

module.exports = {
  createRaidChannelScheduleActions,
};
