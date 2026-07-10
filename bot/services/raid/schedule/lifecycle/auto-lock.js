/**
 * services/raid/schedule/auto-lock.js
 * Passive auto-lock worker for /raid-schedule boards. It scans due open
 * events and atomically flips them to locked, then refreshes the board
 * message so stale Join/Late/Maybe buttons become disabled.
 */

"use strict";

const { getGuildLanguage } = require("../../../i18n");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
} = require("../../../../handlers/raid/schedule/view/board");
const {
  createNonOverlappingIntervalRunner,
} = require("../../schedulers/scheduler-runner");

const RAID_SCHEDULE_AUTO_LOCK_TICK_MS = 60 * 1000;
const RAID_SCHEDULE_AUTO_LOCK_BATCH_SIZE = 25;

function createRaidScheduleAutoLockService({
  RaidEvent,
  GuildConfig,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
}) {
  let interval = null;

  async function editBoard(client, event) {
    if (!event?.channelId || !event?.messageId || !client?.channels) return false;
    try {
      const lang = await getGuildLanguage(event.guildId, { GuildConfigModel: GuildConfig });
      const channel = await client.channels.fetch(event.channelId);
      const message = await channel?.messages?.fetch(event.messageId);
      if (!message) return false;
      await message.edit({
        embeds: [buildScheduleEmbed(event, { EmbedBuilder, UI, lang })],
        components: buildScheduleComponents(event, {
          ActionRowBuilder,
          ButtonBuilder,
          ButtonStyle,
          lang,
        }),
      });
      return true;
    } catch (error) {
      console.warn("[raid-schedule] auto-lock board edit failed:", error?.message || error);
      return false;
    }
  }

  async function runRaidScheduleAutoLockTick(client, now = new Date()) {
    const dueEvents = await RaidEvent.find({
      status: "open",
      autoLockAtStart: true,
      startAt: { $lte: now },
    }).limit(RAID_SCHEDULE_AUTO_LOCK_BATCH_SIZE);

    let locked = 0;
    for (const event of dueEvents) {
      const updated = await RaidEvent.findOneAndUpdate(
        { _id: event._id, status: "open" },
        { $set: { status: "locked" } },
        { new: true },
      );
      if (!updated) continue;
      locked += 1;
      await editBoard(client, updated);
    }
    return { scanned: dueEvents.length, locked };
  }

  const schedulerRunner = createNonOverlappingIntervalRunner({
    tickMs: RAID_SCHEDULE_AUTO_LOCK_TICK_MS,
    runTick: runRaidScheduleAutoLockTick,
    overlapMessage: "[raid-schedule] auto-lock skipped overlapping tick",
    errorMessage: "[raid-schedule] auto-lock scheduler error:",
  });

  function startRaidScheduleAutoLockScheduler(client) {
    if (interval) return;
    interval = schedulerRunner.start(client);
    if (typeof interval.unref === "function") interval.unref();
  }

  function getRaidScheduleAutoLockSchedulerStartedAtMs() {
    return schedulerRunner.getStartedAtMs();
  }

  return {
    RAID_SCHEDULE_AUTO_LOCK_TICK_MS,
    startRaidScheduleAutoLockScheduler,
    runRaidScheduleAutoLockTick,
    getRaidScheduleAutoLockSchedulerStartedAtMs,
  };
}

module.exports = {
  createRaidScheduleAutoLockService,
  RAID_SCHEDULE_AUTO_LOCK_TICK_MS,
};
