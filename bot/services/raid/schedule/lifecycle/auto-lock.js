/**
 * services/raid/schedule/lifecycle/auto-lock.js
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
const { editBoardMessage } = require("../board-io");

const RAID_SCHEDULE_AUTO_LOCK_TICK_MS = 60 * 1000;
const RAID_SCHEDULE_AUTO_LOCK_BATCH_SIZE = 25;
// editBoardMessage reports a Discord outage and a deleted board the same
// way, so a failed edit is retried for about ten minutes and then dropped.
const BOARD_EDIT_RETRY_TICKS = 10;

function createRaidScheduleAutoLockService({
  RaidEvent,
  GuildConfig,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  // The /raid-schedule handlers' boardPayload(event, lang), so an auto-locked
  // board keeps the lead's board-switcher row. Without it the board is rebuilt
  // bare (status + utility rows only).
  boardPayload = null,
}) {
  let interval = null;
  // Event id -> ticks left to retry. A locked event leaves the open-event
  // scan, so a board whose edit failed would otherwise keep its Join
  // buttons. Held in memory: a restart drops the retries.
  const boardEditRetries = new Map();

  async function lockedBoardPayload(event, lang) {
    if (typeof boardPayload === "function") return boardPayload(event, lang);
    return {
      embeds: [buildScheduleEmbed(event, { EmbedBuilder, UI, lang })],
      components: buildScheduleComponents(event, {
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        lang,
      }),
    };
  }

  function editBoard(client, event) {
    return editBoardMessage(client, event || {}, async () => lockedBoardPayload(
      event,
      await getGuildLanguage(event.guildId, { GuildConfigModel: GuildConfig })
    ), { logLabel: "auto-lock board edit failed" });
  }

  async function retryBoardEdits(client) {
    for (const [eventId, ticksLeft] of boardEditRetries) {
      // An event unlocked, cleared or removed since has a newer board.
      const event = await RaidEvent.findOne({ _id: eventId, status: "locked" });
      const settled = !event || await editBoard(client, event);
      if (settled || ticksLeft === 1) boardEditRetries.delete(eventId);
      else boardEditRetries.set(eventId, ticksLeft - 1);
    }
  }

  async function runRaidScheduleAutoLockTick(client, now = new Date()) {
    await retryBoardEdits(client);
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
      if (!(await editBoard(client, updated))) boardEditRetries.set(updated._id, BOARD_EDIT_RETRY_TICKS);
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
};
