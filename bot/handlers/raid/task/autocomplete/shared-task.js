"use strict";

const {
  truncateChoice,
} = require("../../../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../../../services/i18n");
const {
  SHARED_TASK_PRESETS,
  getVisibleSharedTasks,
  getSharedTaskDisplay,
} = require("../../../../utils/raid/tasks/shared-tasks");
const {
  SHARED_TASK_PRESET_ORDER,
  normalizeName,
  sharedTaskHasPreset,
  sharedPresetLabel,
  findAccountInUser,
} = require("../../../../utils/raid/tasks/side-tasks");

function presetStatusFor({ preset, selectedAccount, accounts, now, lang }) {
  if (preset.preset === "custom") {
    return t("raid-task.autocomplete.sharedPresetCustom", lang);
  }
  if (selectedAccount) {
    return sharedTaskHasPreset(selectedAccount, preset.preset, now)
      ? t("raid-task.autocomplete.sharedPresetAdded", lang)
      : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
  }
  if (accounts.length > 0) {
    const count = accounts.filter((account) =>
      sharedTaskHasPreset(account, preset.preset, now)
    ).length;
    return count > 0
      ? t("raid-task.autocomplete.sharedPresetAddedCount", lang, {
          n: count,
          total: accounts.length,
        })
      : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
  }
  return t("raid-task.autocomplete.sharedPresetNoRoster", lang);
}

function createSharedTaskAutocompleteHandlers({
  User,
  loadUserForAutocomplete,
  loadUserDocForRosterAutocomplete,
}) {
  async function autocompleteSharedTask(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const discordId = interaction.user.id;
    if (!rosterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const userDoc = await loadUserDocForRosterAutocomplete(discordId, rosterInput);
    const account = findAccountInUser(userDoc, rosterInput);
    if (!account) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const now = new Date();
    const choices = getVisibleSharedTasks(account, now.getTime())
      .filter((task) => !needle || normalizeName(task?.name).includes(needle))
      .slice(0, 25)
      .map((task) => {
        const display = getSharedTaskDisplay(task, now, lang);
        return truncateChoice(
          `${display.emoji} ${display.name} \u00b7 ${display.optionStatus || display.status}`,
          task.taskId,
        );
      });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteSharedPreset(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const userDoc = rosterInput
      ? await loadUserDocForRosterAutocomplete(interaction.user.id, rosterInput)
      : await loadUserForAutocomplete(interaction.user.id);
    const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
    const selectedAccount = rosterInput
      ? findAccountInUser(userDoc, rosterInput)
      : null;
    const now = Date.now();

    const choices = SHARED_TASK_PRESET_ORDER
      .map((presetKey) => SHARED_TASK_PRESETS[presetKey])
      .filter(Boolean)
      .map((preset) => {
        const label = sharedPresetLabel(preset);
        const status = presetStatusFor({ preset, selectedAccount, accounts, now, lang });
        return {
          label,
          value: preset.preset,
          choice: truncateChoice(`${label} \u00b7 ${status}`, preset.preset),
        };
      })
      .filter(
        (entry) =>
          !needle ||
          normalizeName(entry.label).includes(needle) ||
          normalizeName(entry.value).includes(needle),
      )
      .slice(0, 25)
      .map((entry) => entry.choice);

    await interaction.respond(choices).catch(() => {});
  }

  return {
    autocompleteSharedPreset,
    autocompleteSharedTask,
  };
}

module.exports = {
  createSharedTaskAutocompleteHandlers,
};
