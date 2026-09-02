"use strict";

const {
  resolveCharacterNameFilter,
} = require("../../state/character-filter");

const ALL_CHARS_SENTINEL = "__ALL_CHARS__";

function createTaskFilterState({
  getAccounts,
  getCurrentPage,
  getTaskCharFilter,
  getCharacterName,
}) {
  function charsWithTasksOnPage() {
    const account = getAccounts()[getCurrentPage()];
    const characters = Array.isArray(account?.characters)
      ? account.characters
      : [];
    return characters.filter(
      (character) =>
        Array.isArray(character?.sideTasks) && character.sideTasks.length > 0
    );
  }

  function resolveTaskCharFilter() {
    const explicit = getTaskCharFilter(getCurrentPage());
    const candidates = charsWithTasksOnPage();
    return resolveCharacterNameFilter({
      allCharactersSentinel: ALL_CHARS_SENTINEL,
      candidates,
      explicit,
      getCharacterName,
    });
  }

  function aggregateTasksOnPage() {
    const byKey = new Map();
    for (const character of charsWithTasksOnPage()) {
      const charName = getCharacterName(character);
      const sideTasks = Array.isArray(character.sideTasks)
        ? character.sideTasks
        : [];
      for (const task of sideTasks) {
        if (!task?.name) continue;
        const key = `${task.name.trim().toLowerCase()}::${task.reset}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            name: task.name,
            reset: task.reset,
            owners: [],
            doneCount: 0,
          };
          byKey.set(key, entry);
        }
        entry.owners.push({
          charName,
          taskId: task.taskId,
          completed: !!task.completed,
        });
        if (task.completed) entry.doneCount += 1;
      }
    }
    return [...byKey.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.reset.localeCompare(b.reset)
    );
  }

  return {
    ALL_CHARS_SENTINEL,
    charsWithTasksOnPage,
    resolveTaskCharFilter,
    aggregateTasksOnPage,
  };
}

module.exports = {
  createTaskFilterState,
};
