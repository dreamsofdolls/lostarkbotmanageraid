/**
 * handlers/raid/task.js
 * /raid-task: per-character + roster-level side tasks (Una dailies,
 * Chaos Gate, Field Boss, custom presets). Subcommands: add / remove
 * / clear / shared-add / shared-remove. Auto-reset 17:00 VN daily,
 * Wed 17:00 weekly; scheduled presets follow UTC-4 windows. Toggle
 * complete via the /raid-status side-tasks dropdown.
 */

"use strict";

const { getAccessibleAccounts } = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
const { createRaidTaskAddActionHandlers } = require("./task/add-actions");
const { createRaidTaskAutocompleteHandlers } = require("./task/autocomplete");
const { createRaidTaskClearActionHandlers } = require("./task/clear-actions");
const { createRaidTaskNoticeHelpers } = require("./task/notices");
const { createRaidTaskRemoveActionHandlers } = require("./task/remove-actions");
const {
  RAID_TASK_BUTTON_ACTION,
  getRaidTaskButtonRoute,
} = require("./task/routes");
const { createRaidTaskSharedActionHandlers } = require("./task/shared-actions");
const { createRaidTaskWriteTargetResolver } = require("./task/write-target");
const {
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  ensureSharedTasks,
} = require("../../utils/raid/tasks/shared-tasks");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  generateTaskId,
  findCharacterInUser,
  findAccountInUser,
  resolveTaskWriteTargetFromAccessible,
  ensureSideTasks,
  countByReset,
} = require("../../utils/raid/tasks/side-tasks");

/**
 * Build the /raid-task command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   MessageFlags, Mongoose User model, saveWithRetry, task helpers
 *   from utils/raid/tasks/*, access-control + roster-owner-resolver
 *   for shared rosters · see destructure block).
 * @returns {{
 *   handleRaidTaskCommand: Function,
 *   handleRaidTaskAutocomplete: Function,
 *   handleRaidTaskButton: Function,
 * }} handlers wired into commands.js dispatch + autocomplete + button-
 *   route maps
 */
function createRaidTaskCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User,
    saveWithRetry,
    loadUserForAutocomplete,
    dailyResetStartMs,
    weekResetStartMs,
  } = deps;

  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete,
    getAccessibleAccounts,
  });
  const {
    replyTaskNotice,
    updateTaskNotice,
    replyViewOnlyShareNotice,
    viewOnlyShareNotice,
  } = createRaidTaskNoticeHelpers({ EmbedBuilder });
  const {
    handleAddSingle,
    handleAddAll,
  } = createRaidTaskAddActionHandlers({
    User,
    saveWithRetry,
    dailyResetStartMs,
    weekResetStartMs,
    resolveTaskWriteTarget,
    replyTaskNotice,
    replyViewOnlyShareNotice,
  });
  const {
    handleSharedAdd,
    handleSharedRemove,
  } = createRaidTaskSharedActionHandlers({
    User,
    saveWithRetry,
    dailyResetStartMs,
    weekResetStartMs,
    resolveTaskWriteTarget,
    replyTaskNotice,
    replyViewOnlyShareNotice,
  });
  const { handleRemove } = createRaidTaskRemoveActionHandlers({
    User,
    saveWithRetry,
    resolveTaskWriteTarget,
    replyTaskNotice,
    replyViewOnlyShareNotice,
  });
  const {
    handleClear,
    handleClearConfirmButton,
    handleClearCancelButton,
  } = createRaidTaskClearActionHandlers({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User,
    saveWithRetry,
    resolveTaskWriteTarget,
    replyTaskNotice,
    updateTaskNotice,
    replyViewOnlyShareNotice,
    viewOnlyShareNotice,
  });

  const { handleRaidTaskAutocomplete } = createRaidTaskAutocompleteHandlers({
    User,
    loadUserForAutocomplete,
    resolveTaskWriteTarget,
  });

  const BUTTON_ACTION_HANDLERS = Object.freeze({
    [RAID_TASK_BUTTON_ACTION.clearConfirm]: handleClearConfirmButton,
    [RAID_TASK_BUTTON_ACTION.clearCancel]: handleClearCancelButton,
  });

  async function handleRaidTaskButton(interaction) {
    const route = getRaidTaskButtonRoute(interaction.customId);
    const handler = route ? BUTTON_ACTION_HANDLERS[route.action] : null;
    if (handler) await handler(interaction, route);
  }

  const ADD_ACTION_HANDLERS = Object.freeze({
    single: handleAddSingle,
    all: handleAddAll,
  });

  const SUBCOMMAND_HANDLERS = Object.freeze({
    add: async (interaction) => {
      // Sub-routing by `action`: single -> one specific char (requires
      // `character` field), all -> every char in the roster (no character
      // field needed). Default to "single" if old test mocks omit it.
      const action = interaction.options.getString("action", false) || "single";
      const handler = ADD_ACTION_HANDLERS[action] || handleAddSingle;
      return handler(interaction);
    },
    remove: handleRemove,
    clear: handleClear,
    "shared-add": handleSharedAdd,
    "shared-remove": handleSharedRemove,
  });

  async function handleRaidTaskCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    const handler = SUBCOMMAND_HANDLERS[sub];
    if (handler) return handler(interaction);
    // Fallback path: unknown subcommand. Resolve lang lazily here since
    // we never reach this branch on the happy path.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await replyTaskNotice(interaction, {
      type: "warn",
      title: t("raid-task.invalidSubcommandTitle", lang),
      description: t("raid-task.invalidSubcommandDescription", lang, { sub }),
    });
  }

  return {
    handleRaidTaskCommand,
    handleRaidTaskAutocomplete,
    handleRaidTaskButton,
  };
}

module.exports = {
  createRaidTaskCommand,
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  generateTaskId,
  findCharacterInUser,
  findAccountInUser,
  resolveTaskWriteTargetFromAccessible,
  countByReset,
  ensureSideTasks,
  ensureSharedTasks,
};
