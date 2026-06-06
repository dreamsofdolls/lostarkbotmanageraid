"use strict";

const {
  truncateChoice,
} = require("../../../../utils/raid/common/autocomplete");
const {
  normalizeName,
  findCharacterInUser,
} = require("../../../../utils/raid/tasks/side-tasks");

function createSideTaskAutocompleteHandlers({
  loadUserForAutocomplete,
  loadUserDocForRosterAutocomplete,
  autocompleteSharedTask,
}) {
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

  return {
    autocompleteTask,
    autocompleteTaskName,
  };
}

module.exports = {
  createSideTaskAutocompleteHandlers,
};
