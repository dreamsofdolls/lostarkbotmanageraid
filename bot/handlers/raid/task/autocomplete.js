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
const { createAutocompleteDispatcher } = require("../../../utils/raid/common/autocomplete");

function createRaidTaskAutocompleteHandlers({
  User,
  loadUserForAutocomplete,
  loadAccessibleAccountsForAutocomplete,
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
    loadAccessibleAccountsForAutocomplete,
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

  const handleRaidTaskAutocomplete = createAutocompleteDispatcher("raid-task", dispatchByFocusedName);

  return {
    handleRaidTaskAutocomplete,
  };
}

module.exports = {
  createRaidTaskAutocompleteHandlers,
};
