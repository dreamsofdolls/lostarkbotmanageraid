"use strict";

const {
  createRaidTaskAutocompleteContext,
} = require("./autocomplete/context");
const {
  createRosterAutocompleteHandlers,
} = require("./autocomplete/roster");
const {
  createSharedTaskAutocompleteHandlers,
} = require("./autocomplete/shared-task");
const {
  createSideTaskAutocompleteHandlers,
} = require("./autocomplete/side-task");

function createRaidTaskAutocompleteHandlers({
  User,
  loadUserForAutocomplete,
  resolveTaskWriteTarget,
}) {
  const {
    loadUserDocForRosterAutocomplete,
  } = createRaidTaskAutocompleteContext({
    loadUserForAutocomplete,
    resolveTaskWriteTarget,
  });
  const {
    autocompleteCharacter,
    autocompleteRoster,
  } = createRosterAutocompleteHandlers({
    User,
    loadUserForAutocomplete,
    loadUserDocForRosterAutocomplete,
  });
  const {
    autocompleteSharedPreset,
    autocompleteSharedTask,
  } = createSharedTaskAutocompleteHandlers({
    User,
    loadUserForAutocomplete,
    loadUserDocForRosterAutocomplete,
  });
  const {
    autocompleteTask,
    autocompleteTaskName,
  } = createSideTaskAutocompleteHandlers({
    loadUserForAutocomplete,
    loadUserDocForRosterAutocomplete,
    autocompleteSharedTask,
  });
  const dispatchByFocusedName = {
    character: autocompleteCharacter,
    name: autocompleteTaskName,
    preset: autocompleteSharedPreset,
    roster: autocompleteRoster,
    task: autocompleteTask,
  };

  async function handleRaidTaskAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      const handler = dispatchByFocusedName[focused?.name];
      if (!handler) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      await handler(interaction, focused);
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
