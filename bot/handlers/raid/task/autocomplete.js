"use strict";

const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../../../utils/raid/common/autocomplete");
const { getAccessibleAccounts } = require("../../../services/access/access-control");
const { t, getUserLanguage } = require("../../../services/i18n");
const {
  SHARED_TASK_PRESETS,
  getVisibleSharedTasks,
  getSharedTaskDisplay,
} = require("../../../utils/raid/tasks/shared-tasks");
const {
  SHARED_TASK_PRESET_ORDER,
  normalizeName,
  sharedTaskHasPreset,
  sharedPresetLabel,
  findCharacterInUser,
  findAccountInUser,
} = require("../../../utils/raid/tasks/side-tasks");

function createRaidTaskAutocompleteHandlers({
  User,
  loadUserForAutocomplete,
  resolveTaskWriteTarget,
}) {
  async function loadUserDocForRosterAutocomplete(executorId, rosterName) {
    if (!rosterName) {
      return loadUserForAutocomplete(executorId);
    }
    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare) {
      const ownerDoc = await loadUserForAutocomplete(writeTarget.discordId);
      if (ownerDoc && Array.isArray(ownerDoc.accounts)) {
        return ownerDoc;
      }
    }
    return loadUserForAutocomplete(executorId);
  }

  async function autocompleteRoster(interaction, focused) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const charsWord = (n) =>
      t(
        n === 1 ? "raid-task.autocomplete.charsSingular" : "raid-task.autocomplete.charsPlural",
        lang,
      );
    const taskSuffixFor = (n) =>
      n > 0 ? t("raid-task.autocomplete.taskSuffix", lang, { n }) : "";
    const userDoc = await loadUserForAutocomplete(executorId);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = matches.map((a) => {
      const chars = Array.isArray(a.characters) ? a.characters : [];
      const taskTotal = chars.reduce(
        (sum, c) => sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
        0,
      );
      const label = t("raid-task.autocomplete.ownChoice", lang, {
        name: a.accountName,
        charCount: chars.length,
        charsWord: charsWord(chars.length),
        taskSuffix: taskSuffixFor(taskTotal),
      });
      return truncateChoice(label, a.accountName);
    });

    const target = focused.value ? focused.value.toLowerCase() : "";
    let shareChoices = [];
    try {
      const accessible = await getAccessibleAccounts(executorId);
      shareChoices = accessible
        .filter(
          (entry) =>
            !entry.isOwn &&
            (!target || (entry.accountName || "").toLowerCase().includes(target)),
        )
        .map((entry) => {
          const chars = Array.isArray(entry.account?.characters)
            ? entry.account.characters
            : [];
          const taskTotal = chars.reduce(
            (sum, c) => sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
            0,
          );
          const accessTag =
            entry.accessLevel === "view"
              ? t("raid-task.autocomplete.sharedAccessTagView", lang, {
                  viewLabel: t("share.accessLevel.view", lang),
                })
              : "";
          const label = t("raid-task.autocomplete.sharedChoice", lang, {
            name: entry.accountName,
            charCount: chars.length,
            charsWord: charsWord(chars.length),
            taskSuffix: taskSuffixFor(taskTotal),
            owner: entry.ownerLabel,
            accessTag,
          });
          return truncateChoice(label, entry.accountName);
        });
    } catch (err) {
      console.warn(
        "[raid-task autocomplete] getAccessibleAccounts failed:",
        err?.message || err,
      );
    }

    const merged = [...choices, ...shareChoices].slice(0, 25);
    await interaction.respond(merged).catch(() => {});
  }

  async function autocompleteCharacter(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const userDoc = await loadUserDocForRosterAutocomplete(
      interaction.user.id,
      rosterInput,
    );
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: rosterInput || null,
      needle: focused.value || "",
    });
    const choices = entries.map((entry) => {
      const taskSuffix =
        entry.sideTaskCount > 0 ? ` \u00b7 ${entry.sideTaskCount} task` : "";
      const label = `${entry.name} \u00b7 ${entry.className} \u00b7 ${entry.itemLevel}${taskSuffix}`;
      return truncateChoice(label, entry.name);
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteTaskName(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const seenKey = new Set();
    const candidates = [];
    for (const account of userDoc.accounts) {
      const chars = Array.isArray(account.characters) ? account.characters : [];
      for (const character of chars) {
        const tasks = Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
        for (const task of tasks) {
          if (!task?.name) continue;
          const key = `${normalizeName(task.name)}::${task.reset}`;
          if (seenKey.has(key)) continue;
          if (needle && !normalizeName(task.name).includes(needle)) continue;
          seenKey.add(key);
          candidates.push({
            name: task.name,
            reset: task.reset,
            createdAt: Number(task.createdAt) || 0,
          });
        }
      }
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    const choices = candidates.slice(0, 25).map((c) => {
      const label = `${c.name} \u00b7 ${c.reset}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: c.name.length > 100 ? c.name.slice(0, 100) : c.name,
      };
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteTask(interaction, focused) {
    const subcommand = typeof interaction.options.getSubcommand === "function"
      ? interaction.options.getSubcommand(false)
      : "";
    if (subcommand === "shared-remove") {
      await autocompleteSharedTask(interaction, focused);
      return;
    }

    const needle = normalizeName(focused.value || "");
    const characterInput = interaction.options.getString("character") || "";
    const rosterInput = interaction.options.getString("roster") || "";
    const discordId = interaction.user.id;
    if (!characterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserDocForRosterAutocomplete(discordId, rosterInput);
    const found = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!found) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const sideTasks = Array.isArray(found.character.sideTasks)
      ? found.character.sideTasks
      : [];
    const choices = sideTasks
      .filter((task) => !needle || normalizeName(task?.name).includes(needle))
      .slice(0, 25)
      .map((task) => {
        const icon = task.reset === "daily" ? "\ud83c\udf12" : "\ud83d\udcc5";
        const label = `${icon} ${task.name} \u00b7 ${task.reset}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          value: task.taskId,
        };
      });
    await interaction.respond(choices).catch(() => {});
  }

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
        let status = "";
        if (preset.preset === "custom") {
          status = t("raid-task.autocomplete.sharedPresetCustom", lang);
        } else if (selectedAccount) {
          status = sharedTaskHasPreset(selectedAccount, preset.preset, now)
            ? t("raid-task.autocomplete.sharedPresetAdded", lang)
            : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
        } else if (accounts.length > 0) {
          const count = accounts.filter((account) =>
            sharedTaskHasPreset(account, preset.preset, now)
          ).length;
          status = count > 0
            ? t("raid-task.autocomplete.sharedPresetAddedCount", lang, {
                n: count,
                total: accounts.length,
              })
            : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
        } else {
          status = t("raid-task.autocomplete.sharedPresetNoRoster", lang);
        }

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

  async function handleRaidTaskAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === "roster") {
        await autocompleteRoster(interaction, focused);
        return;
      }
      if (focused?.name === "character") {
        await autocompleteCharacter(interaction, focused);
        return;
      }
      if (focused?.name === "task") {
        await autocompleteTask(interaction, focused);
        return;
      }
      if (focused?.name === "preset") {
        await autocompleteSharedPreset(interaction, focused);
        return;
      }
      if (focused?.name === "name") {
        await autocompleteTaskName(interaction, focused);
        return;
      }
      await interaction.respond([]).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] raid-task error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }

  return {
    handleRaidTaskAutocomplete,
  };
}

module.exports = {
  createRaidTaskAutocompleteHandlers,
};
