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
  rollbackGuildState,
} = require("./guild-state-claim");
const { sleep } = require("../../../utils/async");

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
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return `${vn.toISOString().slice(0, 10)}:${slot.key}`;
}

async function claimMaintenanceTick({ GuildConfig, cfg, conf, groupConfig, tickKey }) {
  return claimGuildState({
    GuildConfig,
    guildId: cfg.guildId,
    guard: {
      [groupConfig.dedupField]: { $ne: tickKey },
      [`announcements.${groupConfig.subdocKey}.enabled`]: { $ne: false },
      raidChannelId: cfg.raidChannelId ?? null,
      [`announcements.${groupConfig.subdocKey}.channelId`]: conf.channelId ?? null,
    },
    claimedState: { [groupConfig.dedupField]: tickKey },
  });
}

async function postClaimedMaintenance({
  cfg,
  channel,
  claimPrevious,
  content,
  GuildConfig,
  groupConfig,
  group,
  postChannelAnnouncement,
  slot,
  tickKey,
  waitBeforeRetry,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      try {
        await waitBeforeRetry(MAINTENANCE_POST_RETRY_DELAY_MS);
      } catch (err) {
        lastError = err;
        break;
      }
    }

    try {
      const sent = await postChannelAnnouncement(
        channel,
        content,
        slot.ttlMs,
        `maintenance ${slot.key}`
      );
      if (sent) {
        console.log(
          `[maintenance] posted guild=${cfg.guildId} group=${group} slot=${slot.key} key=${tickKey} attempt=${attempt}`
        );
        return true;
      }
      lastError = new Error("no message returned");
    } catch (err) {
      lastError = err;
    }
  }

  let claimReleased = false;
  try {
    claimReleased = Boolean(await rollbackGuildState({
      GuildConfig,
      guildId: cfg.guildId,
      claimedState: { [groupConfig.dedupField]: tickKey },
      previousState: claimPrevious,
    }));
  } catch (rollbackError) {
    console.error(
      `[maintenance] guild=${cfg.guildId} slot=${slot.key} claim rollback failed:`,
      rollbackError?.message || rollbackError
    );
  }

  console.warn(
    `[maintenance] send failed after retry; claim ${claimReleased ? "released" : "not released"} guild=${cfg.guildId} slot=${slot.key}:`,
    lastError?.message || lastError
  );
  return false;
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

    const { slot, group } = match;
    const groupConfig = MAINTENANCE_GROUPS[group];
    if (!groupConfig) return;

    const tickKey = maintenanceTickKey(now, slot);
    let configs;
    try {
      configs = await GuildConfig.find(buildMaintenanceConfigQuery()).lean();
    } catch (err) {
      console.error("[maintenance] config load failed:", err?.message || err);
      return;
    }
    if (!configs.length) return;

    for (const cfg of configs) {
      const announcements = getAnnouncementsConfig(cfg);
      const conf = announcements[groupConfig.subdocKey];
      if (!conf?.enabled) continue;
      if (cfg[groupConfig.dedupField] === tickKey) continue;

      const channel = await resolveGuildChannel(client, cfg.guildId, conf.channelId || cfg.raidChannelId);
      if (!channel) continue;

      const guildLang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
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

      await postClaimedMaintenance({
        cfg,
        channel,
        claimPrevious: claimed,
        content,
        GuildConfig,
        groupConfig,
        group,
        postChannelAnnouncement,
        slot,
        tickKey,
        waitBeforeRetry,
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
