/**
 * utils/raid/tasks/side-tasks.js
 * Side-task + shared-task selection helpers shared by /raid-task,
 * /raid-status, and /raid-check. Re-exports normalizeName from
 * shared-tasks so callers don't need to know which sub-module owns the
 * canonical name folder. Caps live here (DAILY=3, WEEKLY=5) because they
 * gate UI render counts, not just storage limits.
 */

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

/**
 * Generate a unique-enough ID for a per-character side-task. Scope is
 * `character.sideTasks[]` (max 8 entries) so collision risk is negligible
 * without pulling in a uuid dep.
 * @returns {string} 10-char base36 ID (6-char random + 4-char timestamp suffix)
 */
function generateTaskId() {
  return (
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

/**
 * Whether a shared task is still "live" (not archived AND not expired).
 * @param {object} task - shared-task sub-document
 * @param {number} [nowMs=Date.now()] - test clock for unit tests
 * @returns {boolean} true if visible in current /raid-task views
 */
function isLiveSharedTask(task, nowMs = Date.now()) {
  if (!task || Number(task.archivedAt) > 0) return false;
  const expiresAt = Number(task.expiresAt) || 0;
  return !(expiresAt > 0 && expiresAt < nowMs);
}

/**
 * Does the account already have a live shared task of this preset kind?
 * Used to block duplicate preset adds (event-shop / chaos-gate / etc.).
 * @param {object} account - account sub-doc with sharedTasks[]
 * @param {string} presetKey - one of SHARED_TASK_PRESETS keys
 * @param {number} [nowMs=Date.now()] - test clock
 * @returns {boolean}
 */
function sharedTaskHasPreset(account, presetKey, nowMs = Date.now()) {
  return ensureSharedTasks(account).some(
    (task) => isLiveSharedTask(task, nowMs) && task?.preset === presetKey
  );
}

/**
 * Block-list check for a candidate shared-task add. Preset/scheduled
 * tasks dedup by preset key; custom tasks dedup by name+reset pair so
 * users can't create two identically-named weekly tasks but a custom
 * weekly + custom daily with the same name is fine.
 * @param {Array} sharedTasks - existing account.sharedTasks[]
 * @param {{preset: string, kind: string}} preset - SHARED_TASK_PRESETS entry
 * @param {string} taskName - candidate task display name
 * @param {string} reset - "daily" | "weekly" | "scheduled"
 * @param {number} [nowMs=Date.now()] - test clock
 * @returns {boolean} true if a duplicate already lives
 */
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

/**
 * Resolve a single (account, character) pair from a user doc. When
 * `rosterName` is supplied, the search is scoped to that account so
 * same-named chars across rosters cannot collide.
 * @param {object} userDoc - mongoose User document (may be plain object)
 * @param {string} characterName - character name to find (case-insensitive)
 * @param {string|null} [rosterName=null] - optional account filter
 * @returns {{account: object, character: object}|null}
 */
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

/**
 * Resolve which user-doc to write into when the executor may be editing
 * a roster shared TO them. Owner check wins · viaShare=true means the
 * caller must mutate the OWNER's User doc, not the executor's, and the
 * grant's accessLevel ("edit"|"view") gates the write.
 * @param {string} executorId - Discord ID of slash-command invoker
 * @param {string|null} rosterName - account/roster name (null = executor's only account)
 * @param {Array} accessible - resolveAccessibleRosters output entries
 * @returns {{discordId: string, viaShare: boolean, ownerLabel?: string, accessLevel?: string, canEdit?: boolean}}
 */
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
