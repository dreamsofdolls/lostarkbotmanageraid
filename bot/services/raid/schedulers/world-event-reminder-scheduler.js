"use strict";

const {
  WORLD_EVENT_REMINDER_TICK_MS,
  WORLD_EVENT_REMINDER_TTL_MS,
  buildWorldEventReminderConfigQuery,
  nextWorldEventReminderBoundaryMs,
  resolveWorldEventReminderForNow,
  worldEventReminderMessageKey,
} = require("../../../utils/raid/schedule/world-events");
const { isDuringArtistSleep } = require("../../../utils/raid/schedule/artist-clock");
const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const {
  claimGuildState,
  releaseGuildClaim,
} = require("./guild-state-claim");

const SUBDOC_KEY = "worldEventReminder";
const DEDUP_FIELD = "lastWorldEventReminderKey";

// What a guild must still be for this reminder: opted in (an explicit true,
// since the reminder is off by default) and not yet reminded of this spawn.
// The guild query and the claim share it, so the claim rechecks the query.
function dueForReminder(reminder) {
  return {
    [DEDUP_FIELD]: { $ne: reminder.key },
    [`announcements.${SUBDOC_KEY}.enabled`]: true,
  };
}

async function claimWorldEventReminder({ GuildConfig, cfg, reminder }) {
  return claimGuildState({
    GuildConfig,
    guildId: cfg.guildId,
    guard: {
      ...dueForReminder(reminder),
      raidChannelId: cfg.raidChannelId ?? null,
      [`announcements.${SUBDOC_KEY}.channelId`]:
        cfg.announcements?.[SUBDOC_KEY]?.channelId ?? null,
    },
    claimedState: { [DEDUP_FIELD]: reminder.key },
  });
}

function buildWorldEventReminderContent({ reminder, lang, t }) {
  const spawnUnix = Math.floor(reminder.spawnAtMs / 1000);
  const ttlMinutes = Math.round(WORLD_EVENT_REMINDER_TTL_MS / 60000);
  return t(worldEventReminderMessageKey(reminder.presetKeys), lang, { spawnUnix, ttlMinutes });
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
      configs = await GuildConfig.find({
        ...buildWorldEventReminderConfigQuery(),
        ...dueForReminder(reminder),
      }).lean();
    } catch (err) {
      console.error("[world-event reminder] config load failed:", err?.message || err);
      return;
    }

    for (const cfg of configs) {
      const conf = getAnnouncementsConfig(cfg)[SUBDOC_KEY];
      const channel = await resolveGuildChannel(
        client,
        cfg.guildId,
        conf.channelId || cfg.raidChannelId
      );
      if (!channel) continue;

      const lang = await getGuildLanguage(cfg.guildId, {
        GuildConfigModel: GuildConfig,
      });
      // The spawn decides, not the post time: a spawn at Artist's wake-up
      // hour is still announced, one inside her sleep is not.
      if (isDuringArtistSleep(reminder.spawnAtMs, lang)) continue;
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

      const claimReleased = await releaseGuildClaim({
        GuildConfig,
        guildId: cfg.guildId,
        claimedState: { [DEDUP_FIELD]: reminder.key },
        previousState: claimed,
      }, (rollbackError) => console.error(
        `[world-event reminder] guild=${cfg.guildId} claim rollback failed:`,
        rollbackError?.message || rollbackError
      ));

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
