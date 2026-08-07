"use strict";

const {
  getSharedTaskPreset,
} = require("../tasks/shared-tasks/config");
const {
  resolveScheduledSharedTaskState,
} = require("../tasks/shared-tasks/schedule");

const WORLD_EVENT_PRESET_KEYS = Object.freeze(["chaos_gate", "field_boss"]);
const WORLD_EVENT_REMINDER_LEAD_MS = 5 * 60 * 1000;
const WORLD_EVENT_REMINDER_TTL_MS = 6 * 60 * 1000;
const WORLD_EVENT_REMINDER_TICK_MS = 60 * 1000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Return the next real spawn strictly after `after`. During an active
 * schedule window, the next slot boundary is a spawn unless it is also the
 * window end (06:00 UTC-4), where the helper advances to the next active day.
 */
function getNextScheduledSpawnAtMs(presetKey, after = new Date()) {
  const date = toDate(after);
  const preset = getSharedTaskPreset(presetKey);
  if (!date || preset.kind !== "scheduled") return null;

  const task = { preset: presetKey };
  const state = resolveScheduledSharedTaskState(task, date);
  if (!state.active) return state.nextAtMs || null;

  if (
    Number.isFinite(state.slotEndAtMs) &&
    Number.isFinite(state.windowEndAtMs) &&
    state.slotEndAtMs < state.windowEndAtMs
  ) {
    return state.slotEndAtMs;
  }

  const afterWindowMs = Number(state.windowEndAtMs || state.slotEndAtMs);
  if (!Number.isFinite(afterWindowMs)) return null;
  const nextState = resolveScheduledSharedTaskState(
    task,
    new Date(afterWindowMs + 1000)
  );
  return nextState.nextAtMs || null;
}

/**
 * Match the single upcoming spawn whose T-5 reminder window currently
 * contains `now`. Looking five minutes ahead reuses the shared-task schedule
 * resolver as the source of truth and naturally handles the overnight window.
 */
function resolveWorldEventReminderForNow(
  now = new Date(),
  leadMs = WORLD_EVENT_REMINDER_LEAD_MS
) {
  const date = toDate(now);
  const lead = Number(leadMs);
  if (!date || !Number.isFinite(lead) || lead <= 0) return null;

  const nowMs = date.getTime();
  const lookAhead = new Date(nowMs + lead);
  const matches = [];

  for (const presetKey of WORLD_EVENT_PRESET_KEYS) {
    const state = resolveScheduledSharedTaskState({ preset: presetKey }, lookAhead);
    const spawnAtMs = Number(state.slotStartAtMs);
    if (
      state.active &&
      Number.isFinite(spawnAtMs) &&
      spawnAtMs > nowMs &&
      spawnAtMs - nowMs <= lead
    ) {
      matches.push({ presetKey, spawnAtMs });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.spawnAtMs - b.spawnAtMs || a.presetKey.localeCompare(b.presetKey));
  const spawnAtMs = matches[0].spawnAtMs;
  const presetKeys = matches
    .filter((match) => match.spawnAtMs === spawnAtMs)
    .map((match) => match.presetKey);

  return {
    key: `world-event:${new Date(spawnAtMs).toISOString()}`,
    presetKeys,
    spawnAtMs,
    reminderAtMs: spawnAtMs - lead,
  };
}

/**
 * Find the next future T-5 boundary across both presets. If the current
 * reminder window is already open, this intentionally advances to the next
 * hourly spawn so `/raid-announce show` never labels a past instant as next.
 */
function nextWorldEventReminderBoundaryMs(
  now = new Date(),
  leadMs = WORLD_EVENT_REMINDER_LEAD_MS
) {
  const date = toDate(now);
  const lead = Number(leadMs);
  if (!date || !Number.isFinite(lead) || lead <= 0) return null;

  const nowMs = date.getTime();
  const candidates = [];
  for (const presetKey of WORLD_EVENT_PRESET_KEYS) {
    let cursor = date;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const spawnAtMs = getNextScheduledSpawnAtMs(presetKey, cursor);
      if (!Number.isFinite(spawnAtMs)) break;
      const boundaryMs = spawnAtMs - lead;
      if (boundaryMs > nowMs) {
        candidates.push(boundaryMs);
        break;
      }
      cursor = new Date(spawnAtMs + 1000);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function worldEventReminderMessageKey(presetKeys) {
  const values = new Set(Array.isArray(presetKeys) ? presetKeys : []);
  if (values.has("chaos_gate") && values.has("field_boss")) {
    return "announcements.world-event-reminder.both";
  }
  if (values.has("field_boss")) {
    return "announcements.world-event-reminder.fieldBoss";
  }
  return "announcements.world-event-reminder.chaosGate";
}

function buildWorldEventReminderConfigQuery() {
  return {
    // Explicit true preserves the opt-in contract for legacy documents whose
    // announcements subdoc predates this reminder.
    "announcements.worldEventReminder.enabled": true,
    $or: [
      { raidChannelId: { $ne: null } },
      { "announcements.worldEventReminder.channelId": { $ne: null } },
    ],
  };
}

module.exports = {
  WORLD_EVENT_PRESET_KEYS,
  WORLD_EVENT_REMINDER_LEAD_MS,
  WORLD_EVENT_REMINDER_TTL_MS,
  WORLD_EVENT_REMINDER_TICK_MS,
  getNextScheduledSpawnAtMs,
  resolveWorldEventReminderForNow,
  nextWorldEventReminderBoundaryMs,
  worldEventReminderMessageKey,
  buildWorldEventReminderConfigQuery,
};
