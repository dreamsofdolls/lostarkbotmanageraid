"use strict";

const ALL_CHARS_SENTINEL = "__ALL_CHARS__";

function sameName(left, right) {
  return String(left || "").trim().toLowerCase() ===
    String(right || "").trim().toLowerCase();
}

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
    if (candidates.length === 0) return null;
    if (explicit === ALL_CHARS_SENTINEL) return ALL_CHARS_SENTINEL;
    if (explicit) {
      const stillExists = candidates.find((character) =>
        sameName(getCharacterName(character), explicit)
      );
      if (stillExists) return getCharacterName(stillExists);
    }
    return getCharacterName(candidates[0]);
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
  ALL_CHARS_SENTINEL,
  createTaskFilterState,
};
