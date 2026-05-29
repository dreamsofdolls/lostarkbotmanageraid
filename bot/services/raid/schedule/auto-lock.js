/**
 * services/raid/schedule/auto-lock.js
 * Passive auto-lock worker for /raid-schedule boards. It scans due open
 * events and atomically flips them to locked, then refreshes the board
 * message so stale Join/Late/Maybe buttons become disabled.
 */

"use strict";

const { getGuildLanguage } = require("../../i18n");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
} = require("../../../handlers/raid/schedule/board");

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
  let schedulerStartedAtMs = null;
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

  function startRaidScheduleAutoLockScheduler(client) {
    if (interval) return;
    schedulerStartedAtMs = Date.now();
    const tick = () => {
      runRaidScheduleAutoLockTick(client).catch((error) => {
        console.error("[raid-schedule] auto-lock scheduler error:", error);
      });
    };
    tick();
    interval = setInterval(tick, RAID_SCHEDULE_AUTO_LOCK_TICK_MS);
    if (typeof interval.unref === "function") interval.unref();
  }

  function getRaidScheduleAutoLockSchedulerStartedAtMs() {
    return schedulerStartedAtMs;
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
