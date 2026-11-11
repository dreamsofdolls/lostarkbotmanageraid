"use strict";

const {
  MAINTENANCE_TICK_MS,
  buildMaintenanceConfigQuery,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
} = require("../../../utils/raid/schedule/maintenance");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");
const {
  claimGuildState,
  sendClaimedPost,
} = require("./guild-state-claim");
const { sleep } = require("../../../utils/async");
const { isDuringArtistSleep, toLocalClock } = require("../../../utils/raid/schedule/artist-clock");

const MAINTENANCE_POST_RETRY_DELAY_MS = 1_000;

const MAINTENANCE_GROUPS = {
  early: {
    subdocKey: "maintenanceEarly",
    dedupField: "lastMaintenanceEarlyKey",
  },
  countdown: {
    subdocKey: "maintenanceCountdown",
    dedupField: "lastMaintenanceCountdownKey",
  },
};

function maintenanceTickKey(now, slot) {
  return `${toLocalClock(now, "vi").toISOString().slice(0, 10)}:${slot.key}`;
}

// What a guild must still be for this tick: its group switched on (both
// maintenance types default on) and this tick not yet posted. The guild query
// and the claim share it, so the claim rechecks what the query selected.
function dueForTick(groupConfig, tickKey) {
  return {
    [groupConfig.dedupField]: { $ne: tickKey },
    [`announcements.${groupConfig.subdocKey}.enabled`]: { $ne: false },
  };
}

async function claimMaintenanceTick({ GuildConfig, cfg, conf, groupConfig, tickKey }) {
  return claimGuildState({
    GuildConfig,
    guildId: cfg.guildId,
    guard: {
      ...dueForTick(groupConfig, tickKey),
      raidChannelId: cfg.raidChannelId ?? null,
      [`announcements.${groupConfig.subdocKey}.channelId`]: conf.channelId ?? null,
    },
    claimedState: { [groupConfig.dedupField]: tickKey },
  });
}

function createMaintenanceSchedulerService({
  GuildConfig,
  getAnnouncementsConfig,
  getGuildLanguage,
  postChannelAnnouncement,
  nowDate = () => new Date(),
  waitBeforeRetry = sleep,
}) {
  async function runMaintenanceTick(client) {
    const now = nowDate();
    const match = getMaintenanceSlotForNow(now);
    if (!match) return;

    const { slot, group, startMs } = match;
    // getMaintenanceSlotForNow names only the groups keyed here.
    const groupConfig = MAINTENANCE_GROUPS[group];

    const tickKey = maintenanceTickKey(now, slot);
    let configs;
    try {
      configs = await GuildConfig.find({
        ...buildMaintenanceConfigQuery(),
        ...dueForTick(groupConfig, tickKey),
      }).lean();
    } catch (err) {
      console.error("[maintenance] config load failed:", err?.message || err);
      return;
    }

    for (const cfg of configs) {
      const announcements = getAnnouncementsConfig(cfg);
      const conf = announcements[groupConfig.subdocKey];
      const channel = await resolveGuildChannel(client, cfg.guildId, conf.channelId || cfg.raidChannelId);
      if (!channel) continue;

      const guildLang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
      // The maintenance start decides: Artist posts nothing on her own while
      // she sleeps on the guild's clock.
      if (isDuringArtistSleep(startMs, guildLang)) continue;
      const content = pickMaintenanceVariant(slot.key, guildLang);
      if (!content) continue;

      let claimed;
      try {
        claimed = await claimMaintenanceTick({ GuildConfig, cfg, conf, groupConfig, tickKey });
      } catch (err) {
        console.error(
          `[maintenance] guild=${cfg.guildId} slot=${slot.key} claim failed:`,
          err?.message || err
        );
        continue;
      }
      if (!claimed) continue;

      await sendClaimedPost({
        send: () => postChannelAnnouncement(channel, content, slot.ttlMs, `maintenance ${slot.key}`),
        claim: { GuildConfig, guildId: cfg.guildId, claimedState: { [groupConfig.dedupField]: tickKey }, previousState: claimed },
        label: "[maintenance]",
        detail: `group=${group} slot=${slot.key} key=${tickKey}`,
        attempts: 2,
        waitBeforeRetry: () => waitBeforeRetry(MAINTENANCE_POST_RETRY_DELAY_MS),
      });
    }
  }

  const runner = createNonOverlappingIntervalRunner({
    tickMs: MAINTENANCE_TICK_MS,
    runTick: runMaintenanceTick,
    overlapMessage: "[maintenance] previous tick still running - skipping this fire to avoid overlap",
    errorMessage: "[maintenance] scheduler tick failed:",
  });

  return {
    MAINTENANCE_TICK_MS,
    runMaintenanceTick,
    startMaintenanceScheduler: (client) => runner.start(client),
    getMaintenanceSchedulerStartedAtMs: runner.getStartedAtMs,
  };
}

module.exports = {
  createMaintenanceSchedulerService,
};
