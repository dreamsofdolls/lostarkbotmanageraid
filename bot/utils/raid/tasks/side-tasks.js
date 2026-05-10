"use strict";

const {
  SCHEDULED_RESET,
  ensureSharedTasks,
  formatSharedResetLabel,
  normalizeName,
} = require("./shared-tasks");

const TASK_CAP_DAILY = 3;
const TASK_CAP_WEEKLY = 5;
const SHARED_TASK_PRESET_ORDER = [
  "event_shop",
  "chaos_gate",
  "field_boss",
  "custom",
];

function generateTaskId() {
  // 10-char base36 from random + timestamp suffix. Collision risk is
  // negligible at our scale (per-character scope, max 8 tasks per char)
  // and avoids pulling in a uuid dep just to namespace eight items.
  return (
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

function isLiveSharedTask(task, nowMs = Date.now()) {
  if (!task || Number(task.archivedAt) > 0) return false;
  const expiresAt = Number(task.expiresAt) || 0;
  return !(expiresAt > 0 && expiresAt < nowMs);
}

function sharedTaskHasPreset(account, presetKey, nowMs = Date.now()) {
  return ensureSharedTasks(account).some(
    (task) => isLiveSharedTask(task, nowMs) && task?.preset === presetKey
  );
}

function isDuplicateSharedTask(sharedTasks, preset, taskName, reset, nowMs = Date.now()) {
  return (Array.isArray(sharedTasks) ? sharedTasks : []).some((task) => {
    if (!isLiveSharedTask(task, nowMs)) return false;
    if (preset.preset !== "custom" && task.preset === preset.preset) {
      return true;
    }
    if (preset.kind === "scheduled") {
      return task.preset === preset.preset;
    }
    return (
      normalizeName(task.name) === normalizeName(taskName) &&
      task.reset === reset
    );
  });
}

function sharedPresetLabel(preset) {
  if (preset.preset === "chaos_gate") return "Chaos Gate (UTC-4)";
  if (preset.preset === "field_boss") return "Field Boss (UTC-4)";
  return preset.label;
}

function formatSharedResetDetail(reset, { t, lang }) {
  if (reset === "daily") return t("raid-task.sharedAdd.resetDetailDaily", lang);
  if (reset === "weekly") return t("raid-task.sharedAdd.resetDetailWeekly", lang);
  if (reset === SCHEDULED_RESET) return t("raid-task.sharedAdd.resetDetailScheduled", lang);
  return formatSharedResetLabel(reset, lang);
}

function getCharacterDisplayName(character) {
  return String(character?.name || character?.charName || "").trim();
}

// Resolve a single (account, character) pair from a user doc. When
// `rosterName` is supplied, the search is scoped to that account so
// same-named chars across rosters cannot collide.
function findCharacterInUser(userDoc, characterName, rosterName = null) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(characterName);
  if (!target) return null;
  const rosterTarget = rosterName ? normalizeName(rosterName) : null;
  for (const account of userDoc.accounts) {
    if (rosterTarget && normalizeName(account.accountName) !== rosterTarget) {
      continue;
    }
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterDisplayName(character)) === target) {
        return { account, character };
      }
    }
  }
  return null;
}

function findAccountInUser(userDoc, rosterName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(rosterName);
  if (!target) return null;
  return (
    userDoc.accounts.find((account) => normalizeName(account?.accountName) === target) ||
    null
  );
}

function resolveTaskWriteTargetFromAccessible(executorId, rosterName, accessible) {
  if (!rosterName) {
    return { discordId: executorId, viaShare: false };
  }
  const target = normalizeName(rosterName);
  if (!target) {
    return { discordId: executorId, viaShare: false };
  }
  const entries = Array.isArray(accessible) ? accessible : [];
  const ownMatch = entries.find(
    (entry) => entry?.isOwn && normalizeName(entry.accountName) === target
  );
  if (ownMatch) {
    return { discordId: executorId, viaShare: false };
  }
  const sharedMatch = entries.find(
    (entry) => !entry?.isOwn && normalizeName(entry.accountName) === target
  );
  if (!sharedMatch) {
    return { discordId: executorId, viaShare: false };
  }
  return {
    discordId: sharedMatch.ownerDiscordId,
    viaShare: true,
    ownerLabel: sharedMatch.ownerLabel,
    accessLevel: sharedMatch.accessLevel,
    canEdit: sharedMatch.accessLevel === "edit",
  };
}

function ensureSideTasks(character) {
  if (!Array.isArray(character.sideTasks)) {
    character.sideTasks = [];
  }
  return character.sideTasks;
}

function countByReset(sideTasks, reset) {
  return sideTasks.filter((task) => task?.reset === reset).length;
}

module.exports = {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  SHARED_TASK_PRESET_ORDER,
  generateTaskId,
  normalizeName,
  isLiveSharedTask,
  sharedTaskHasPreset,
  isDuplicateSharedTask,
  sharedPresetLabel,
  formatSharedResetDetail,
  getCharacterDisplayName,
  findCharacterInUser,
  findAccountInUser,
  resolveTaskWriteTargetFromAccessible,
  ensureSideTasks,
  countByReset,
};
