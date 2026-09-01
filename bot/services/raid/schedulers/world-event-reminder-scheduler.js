"use strict";

const {
  WORLD_EVENT_REMINDER_TICK_MS,
  WORLD_EVENT_REMINDER_TTL_MS,
  buildWorldEventReminderConfigQuery,
  nextWorldEventReminderBoundaryMs,
  resolveWorldEventReminderForNow,
  worldEventReminderMessageKey,
} = require("../../../utils/raid/schedule/world-events");
const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const {
  claimGuildState,
  rollbackGuildState,
} = require("./guild-state-claim");

const SUBDOC_KEY = "worldEventReminder";
const DEDUP_FIELD = "lastWorldEventReminderKey";

async function claimWorldEventReminder({ GuildConfig, cfg, reminder }) {
  return claimGuildState({
    GuildConfig,
    guildId: cfg.guildId,
    guard: {
      [DEDUP_FIELD]: { $ne: reminder.key },
      [`announcements.${SUBDOC_KEY}.enabled`]: true,
      raidChannelId: cfg.raidChannelId ?? null,
      [`announcements.${SUBDOC_KEY}.channelId`]:
        cfg.announcements?.[SUBDOC_KEY]?.channelId ?? null,
    },
    claimedState: { [DEDUP_FIELD]: reminder.key },
  });
}

function buildWorldEventReminderContent({ reminder, lang, t }) {
  const spawnUnix = Math.floor(reminder.spawnAtMs / 1000);
  return t(worldEventReminderMessageKey(reminder.presetKeys), lang, { spawnUnix });
}

function createWorldEventReminderSchedulerService({
  GuildConfig,
  getAnnouncementsConfig,
  getGuildLanguage,
  postChannelAnnouncement,
  t,
  nowDate = () => new Date(),
}) {
  async function runWorldEventReminderTick(client) {
    const reminder = resolveWorldEventReminderForNow(nowDate());
    if (!reminder) return;

    let configs;
    try {
      configs = await GuildConfig.find(buildWorldEventReminderConfigQuery()).lean();
    } catch (err) {
      console.error("[world-event reminder] config load failed:", err?.message || err);
      return;
    }
    if (!configs.length) return;

    for (const cfg of configs) {
      const conf = getAnnouncementsConfig(cfg)[SUBDOC_KEY];
      if (!conf?.enabled || cfg[DEDUP_FIELD] === reminder.key) continue;

      const channel = await resolveGuildChannel(
        client,
        cfg.guildId,
        conf.channelId || cfg.raidChannelId
      );
      if (!channel) continue;

      const lang = await getGuildLanguage(cfg.guildId, {
        GuildConfigModel: GuildConfig,
      });
      const content = buildWorldEventReminderContent({ reminder, lang, t });

      let claimed;
      try {
        claimed = await claimWorldEventReminder({ GuildConfig, cfg, reminder });
      } catch (err) {
        console.error(
          `[world-event reminder] guild=${cfg.guildId} claim failed:`,
          err?.message || err
        );
        continue;
      }
      if (!claimed) continue;

      let sent = null;
      let postError = null;
      try {
        sent = await postChannelAnnouncement(
          channel,
          content,
          WORLD_EVENT_REMINDER_TTL_MS,
          "world-event reminder"
        );
      } catch (err) {
        postError = err;
      }

      if (sent) {
        console.log(
          `[world-event reminder] posted guild=${cfg.guildId} events=${reminder.presetKeys.join("+")} key=${reminder.key}`
        );
        continue;
      }

      let claimReleased = false;
      try {
        claimReleased = Boolean(await rollbackGuildState({
          GuildConfig,
          guildId: cfg.guildId,
          claimedState: { [DEDUP_FIELD]: reminder.key },
          previousState: claimed,
        }));
      } catch (rollbackError) {
        console.error(
          `[world-event reminder] guild=${cfg.guildId} claim rollback failed:`,
          rollbackError?.message || rollbackError
        );
      }

      console.warn(
        `[world-event reminder] send failed; claim ${claimReleased ? "released" : "not released"} guild=${cfg.guildId} key=${reminder.key}:`,
        postError?.message || postError || "no message returned"
      );
    }
  }

  const runner = createNonOverlappingIntervalRunner({
    tickMs: WORLD_EVENT_REMINDER_TICK_MS,
    runTick: runWorldEventReminderTick,
    overlapMessage: "[world-event reminder] previous tick still running - skipping overlap",
    errorMessage: "[world-event reminder] scheduler tick failed:",
  });

  return {
    WORLD_EVENT_REMINDER_TICK_MS,
    nextWorldEventReminderBoundaryMs,
    runWorldEventReminderTick,
    startWorldEventReminderScheduler: (client) => runner.start(client),
    getWorldEventReminderSchedulerStartedAtMs: runner.getStartedAtMs,
  };
}

module.exports = {
  createWorldEventReminderSchedulerService,
};
