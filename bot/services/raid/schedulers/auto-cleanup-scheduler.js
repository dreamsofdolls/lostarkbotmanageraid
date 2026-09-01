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
const {
  claimGuildState,
  rollbackGuildState,
} = require("./guild-state-claim");

const AUTO_CLEANUP_NOTICE_TTL_MS = 5 * 60 * 1000;
const ARTIST_BEDTIME_NOTICE_TTL_MS = 5 * 60 * 1000;
const ARTIST_WAKEUP_NOTICE_TTL_MS = 10 * 60 * 1000;
const AUTO_CLEANUP_TICK_MS = 30 * 60 * 1000;

function isAnnouncementEnabled(announcements, key) {
  return announcements?.[key]?.enabled !== false;
}

async function rollbackPhaseClaim({ GuildConfig, cfg, claimedState, previousState, phaseName }) {
  try {
    await rollbackGuildState({
      GuildConfig,
      guildId: cfg.guildId,
      claimedState,
      previousState: previousState || cfg,
    });
  } catch (err) {
    console.error(
      `[raid-channel] ${phaseName} claim rollback failed guild=${cfg.guildId}:`,
      err?.message || err
    );
  }
}

async function runQuietPhase(context) {
  const {
    GuildConfig,
    cfg,
    channel,
    dayKey,
    getAnnouncementsConfig,
    guildLang,
    postChannelAnnouncement,
  } = context;

  if (cfg.lastArtistBedtimeKey === dayKey) return;
  const claimedState = { lastArtistBedtimeKey: dayKey };
  let claimPrevious = null;

  try {
    claimPrevious = await claimGuildState({
      GuildConfig,
      guildId: cfg.guildId,
      guard: {
        autoCleanupEnabled: true,
        raidChannelId: cfg.raidChannelId,
        lastArtistBedtimeKey: { $ne: dayKey },
      },
      claimedState,
    });
    if (!claimPrevious) return;
    const announcements = getAnnouncementsConfig(claimPrevious);
    if (!isAnnouncementEnabled(announcements, "artistBedtime")) return;

    const sent = await postChannelAnnouncement(
      channel,
      pickBedtimeNoticeContent(guildLang),
      ARTIST_BEDTIME_NOTICE_TTL_MS,
      "raid-channel artist-bedtime"
    );
    if (sent) {
      console.log(`[raid-channel] artist-bedtime guild=${cfg.guildId} day=${dayKey}`);
    } else {
      await rollbackPhaseClaim({
        GuildConfig,
        cfg,
        claimedState,
        previousState: claimPrevious,
        phaseName: "artist-bedtime",
      });
    }
  } catch (err) {
    if (claimPrevious) {
      await rollbackPhaseClaim({
        GuildConfig,
        cfg,
        claimedState,
        previousState: claimPrevious,
        phaseName: "artist-bedtime",
      });
    }
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
    cleanupAndRefreshRaidChannel,
    getAnnouncementsConfig,
    guildLang,
    postChannelAnnouncement,
  } = context;

  let claimPrevious = null;
  let cleanupFinished = false;
  try {
    claimPrevious = await claimGuildState({
      GuildConfig,
      guildId: cfg.guildId,
      guard: {
        autoCleanupEnabled: true,
        raidChannelId: cfg.raidChannelId,
        [phaseName === "artist-wakeup" ? "lastArtistWakeupKey" : "lastAutoCleanupKey"]: {
          $ne: phaseName === "artist-wakeup" ? context.dayKey : context.targetKey,
        },
      },
      claimedState: persistedState,
    });
    if (!claimPrevious) return;
    const announcements = getAnnouncementsConfig(claimPrevious);

    const { deleted, skippedOld } = await cleanupAndRefreshRaidChannel(channel, {
      botUserId: context.client.user.id,
      client: context.client,
      guildId: cfg.guildId,
      protectedMessageIds: [cfg.welcomeMessageId].filter(Boolean),
    });
    cleanupFinished = true;
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
    if (claimPrevious && !cleanupFinished) {
      await rollbackPhaseClaim({
        GuildConfig,
        cfg,
        claimedState: persistedState,
        previousState: claimPrevious,
        phaseName,
      });
    }
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
        cleanupAndRefreshRaidChannel,
        getAnnouncementsConfig,
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
  createAutoCleanupSchedulerService,
};
