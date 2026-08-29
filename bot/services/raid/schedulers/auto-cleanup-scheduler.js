"use strict";

const {
  getTargetCleanupSlotKey,
  getTargetDayKeyForLang,
  hasReachedArtistWakeupBoundaryForLang,
  isInArtistQuietHoursForLang,
} = require("../../../utils/raid/schedule/artist-clock");
const {
  pickBedtimeNoticeContent,
  pickCleanupNoticeContent,
  pickWakeupNoticeContent,
} = require("../../../utils/raid/schedule/cleanup-notices");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");

const AUTO_CLEANUP_NOTICE_TTL_MS = 5 * 60 * 1000;
const ARTIST_BEDTIME_NOTICE_TTL_MS = 5 * 60 * 1000;
const ARTIST_WAKEUP_NOTICE_TTL_MS = 10 * 60 * 1000;
const AUTO_CLEANUP_TICK_MS = 30 * 60 * 1000;

function isAnnouncementEnabled(announcements, key) {
  return announcements?.[key]?.enabled !== false;
}

async function stampBedtimeSuppressed({ GuildConfig, cfg, dayKey }) {
  try {
    await GuildConfig.findOneAndUpdate(
      { guildId: cfg.guildId },
      { $set: { lastArtistBedtimeKey: dayKey } }
    );
  } catch (err) {
    console.error(
      `[raid-channel] artist-bedtime disabled-stamp failed guild=${cfg.guildId}:`,
      err?.message || err
    );
  }
}

async function runQuietPhase(context) {
  const {
    GuildConfig,
    cfg,
    channel,
    announcements,
    dayKey,
    guildLang,
    postChannelAnnouncement,
  } = context;

  if (cfg.lastArtistBedtimeKey === dayKey) return;
  if (!isAnnouncementEnabled(announcements, "artistBedtime")) {
    await stampBedtimeSuppressed({ GuildConfig, cfg, dayKey });
    return;
  }

  try {
    const sent = await postChannelAnnouncement(
      channel,
      pickBedtimeNoticeContent(guildLang),
      ARTIST_BEDTIME_NOTICE_TTL_MS,
      "raid-channel artist-bedtime"
    );
    if (sent) {
      await GuildConfig.findOneAndUpdate(
        { guildId: cfg.guildId },
        { $set: { lastArtistBedtimeKey: dayKey } }
      );
      console.log(`[raid-channel] artist-bedtime guild=${cfg.guildId} day=${dayKey}`);
    }
  } catch (err) {
    console.error(
      `[raid-channel] artist-bedtime failed guild=${cfg.guildId}:`,
      err?.message || err
    );
  }
}

async function runCleanupPhase(context, {
  phaseName,
  persistedState,
  logState,
  announcementKey,
  pickNoticeContent,
  noticeTtlMs,
}) {
  const {
    GuildConfig,
    cfg,
    channel,
    announcements,
    cleanupAndRefreshRaidChannel,
    guildLang,
    postChannelAnnouncement,
  } = context;

  try {
    const { deleted, skippedOld } = await cleanupAndRefreshRaidChannel(channel, {
      botUserId: context.client.user.id,
      client: context.client,
      guildId: cfg.guildId,
      protectedMessageIds: [cfg.welcomeMessageId].filter(Boolean),
    });
    await GuildConfig.findOneAndUpdate(
      { guildId: cfg.guildId },
      { $set: persistedState }
    );
    console.log(
      `[raid-channel] ${phaseName} guild=${cfg.guildId} ${logState} deleted=${deleted} skippedOld=${skippedOld}`
    );
    if (isAnnouncementEnabled(announcements, announcementKey)) {
      await postChannelAnnouncement(
        channel,
        pickNoticeContent(deleted, guildLang),
        noticeTtlMs,
        `raid-channel ${phaseName}`
      );
    }
  } catch (err) {
    console.error(
      `[raid-channel] ${phaseName} failed guild=${cfg.guildId}:`,
      err?.message || err
    );
  }
}

async function runWakeupPhase(context) {
  await runCleanupPhase(context, {
    phaseName: "artist-wakeup",
    persistedState: {
      lastArtistWakeupKey: context.dayKey,
      lastAutoCleanupKey: context.targetKey,
    },
    logState: `day=${context.dayKey}`,
    announcementKey: "artistWakeup",
    pickNoticeContent: pickWakeupNoticeContent,
    noticeTtlMs: ARTIST_WAKEUP_NOTICE_TTL_MS,
  });
}

async function runNormalCleanupPhase(context) {
  await runCleanupPhase(context, {
    phaseName: "auto-cleanup",
    persistedState: { lastAutoCleanupKey: context.targetKey },
    logState: `key=${context.targetKey}`,
    announcementKey: "hourlyCleanupNotice",
    pickNoticeContent: pickCleanupNoticeContent,
    noticeTtlMs: AUTO_CLEANUP_NOTICE_TTL_MS,
  });
}

const CLEANUP_PHASES = [
  {
    name: "quiet",
    applies: (context) => context.quiet,
    run: runQuietPhase,
  },
  {
    name: "wakeup",
    applies: (context) =>
      hasReachedArtistWakeupBoundaryForLang(context.now, context.guildLang) &&
      context.cfg.lastArtistWakeupKey !== context.dayKey,
    run: runWakeupPhase,
  },
  {
    name: "normal",
    applies: (context) => context.cfg.lastAutoCleanupKey !== context.targetKey,
    run: runNormalCleanupPhase,
  },
];

function createAutoCleanupSchedulerService({
  GuildConfig,
  getAnnouncementsConfig,
  cleanupAndRefreshRaidChannel,
  getGuildLanguage,
  postChannelAnnouncement,
  nowDate = () => new Date(),
}) {
  async function runAutoCleanupTick(client) {
    const now = nowDate();
    const targetKey = getTargetCleanupSlotKey(now);
    let configs;
    try {
      configs = await GuildConfig.find({
        autoCleanupEnabled: true,
        raidChannelId: { $ne: null },
      }).lean();
    } catch (err) {
      console.error("[raid-channel] auto-cleanup config load failed:", err?.message || err);
      return;
    }
    if (!configs.length) return;

    for (const cfg of configs) {
      const channel = await resolveGuildChannel(client, cfg.guildId, cfg.raidChannelId);
      if (!channel) continue;

      const guildLang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
      const context = {
        GuildConfig,
        cfg,
        channel,
        client,
        announcements: getAnnouncementsConfig(cfg),
        cleanupAndRefreshRaidChannel,
        dayKey: getTargetDayKeyForLang(now, guildLang),
        guildLang,
        now,
        postChannelAnnouncement,
        quiet: isInArtistQuietHoursForLang(now, guildLang),
        targetKey,
      };

      const phase = CLEANUP_PHASES.find((entry) => entry.applies(context));
      if (phase) await phase.run(context);
    }
  }

  const runner = createNonOverlappingIntervalRunner({
    tickMs: AUTO_CLEANUP_TICK_MS,
    runTick: runAutoCleanupTick,
    overlapMessage: "[raid-channel] previous scheduler tick still running - skipping this fire to avoid overlap",
    errorMessage: "[raid-channel] scheduler tick failed:",
  });

  return {
    AUTO_CLEANUP_TICK_MS,
    runAutoCleanupTick,
    startRaidChannelScheduler: (client) => runner.start(client),
    getAutoCleanupSchedulerStartedAtMs: runner.getStartedAtMs,
  };
}

module.exports = {
  AUTO_CLEANUP_TICK_MS,
  createAutoCleanupSchedulerService,
};
