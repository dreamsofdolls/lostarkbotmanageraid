"use strict";

const {
  MAINTENANCE_TICK_MS,
  buildMaintenanceConfigQuery,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
} = require("../../../utils/raid/schedule/maintenance");
const { createNonOverlappingIntervalRunner } = require("./scheduler-runner");
const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");

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

async function claimMaintenanceTick({ GuildConfig, cfg, groupConfig, tickKey }) {
  return GuildConfig.findOneAndUpdate(
    {
      guildId: cfg.guildId,
      [groupConfig.dedupField]: { $ne: tickKey },
      [`announcements.${groupConfig.subdocKey}.enabled`]: { $ne: false },
    },
    { $set: { [groupConfig.dedupField]: tickKey } },
    { new: true }
  ).lean();
}

async function postClaimedMaintenance({
  cfg,
  channel,
  content,
  group,
  postChannelAnnouncement,
  slot,
  tickKey,
}) {
  let sent;
  try {
    sent = await postChannelAnnouncement(
      channel,
      content,
      slot.ttlMs,
      `maintenance ${slot.key}`
    );
  } catch (err) {
    console.error(
      `[maintenance] guild=${cfg.guildId} slot=${slot.key} post threw (dedup stamped, slot lost until next cycle):`,
      err?.message || err
    );
    return;
  }

  if (sent) {
    console.log(
      `[maintenance] posted guild=${cfg.guildId} group=${group} slot=${slot.key} key=${tickKey}`
    );
    return;
  }

  console.warn(
    `[maintenance] claimed but send failed guild=${cfg.guildId} slot=${slot.key} (dedup stamped, slot lost until next cycle, check channel permissions or Discord availability)`
  );
}

function createMaintenanceSchedulerService({
  GuildConfig,
  getAnnouncementsConfig,
  getGuildLanguage,
  postChannelAnnouncement,
  nowDate = () => new Date(),
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
        claimed = await claimMaintenanceTick({ GuildConfig, cfg, groupConfig, tickKey });
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
        content,
        group,
        postChannelAnnouncement,
        slot,
        tickKey,
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
  MAINTENANCE_GROUPS,
  createMaintenanceSchedulerService,
};
