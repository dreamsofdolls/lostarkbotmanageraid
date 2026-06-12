"use strict";

const { parseCustomEmoji } = require("../../../../utils/discord/emoji");

function createTaskToggleRows({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UI,
  getClassEmoji,
  getCharacterName,
  truncateText,
  lang,
  getAccounts,
  getCurrentPage,
  filterState,
  t,
}) {
  const {
    ALL_CHARS_SENTINEL,
    charsWithTasksOnPage,
    resolveTaskCharFilter,
    aggregateTasksOnPage,
  } = filterState;

  function buildEmptyToggleRow({ placeholder }) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-task:toggle")
        .setPlaceholder(placeholder)
        .setDisabled(true)
        .addOptions([{ label: "(empty)", value: "noop" }])
    );
  }

  function buildTaskCharFilterRow(disabled) {
    const candidates = charsWithTasksOnPage();
    if (candidates.length === 0) return null;
    const activeName = resolveTaskCharFilter();
    const options = [];

    if (candidates.length > 1) {
      const taskStats = candidates.reduce(
        (acc, character) => {
          const sideTasks = Array.isArray(character.sideTasks)
            ? character.sideTasks
            : [];
          acc.total += sideTasks.length;
          acc.done += sideTasks.filter((task) => task?.completed).length;
          return acc;
        },
        { total: 0, done: 0 }
      );
      options.push({
        label: truncateText(
          t("raid-status.taskView.charFilterAllLabel", lang, {
            done: taskStats.done,
            total: taskStats.total,
          }),
          100
        ),
        value: ALL_CHARS_SENTINEL,
        description: t("raid-status.taskView.charFilterAllDescription", lang),
        default: activeName === ALL_CHARS_SENTINEL,
      });
    }

    const charSlots = candidates.length > 1 ? 24 : 25;
    for (const character of candidates.slice(0, charSlots)) {
      const name = getCharacterName(character);
      const sideTasks = Array.isArray(character.sideTasks)
        ? character.sideTasks
        : [];
      const doneCount = sideTasks.filter((task) => task?.completed).length;
      const label = truncateText(
        `${name} \u00B7 ${Number(character.itemLevel) || 0} \u00B7 ${doneCount}/${sideTasks.length}`,
        100
      );
      const option = {
        label,
        value: name.slice(0, 100),
        default:
          !!activeName &&
          name.trim().toLowerCase() === activeName.trim().toLowerCase(),
      };
      const classEmojiObj = parseCustomEmoji(
        getClassEmoji(character.class || character.className)
      );
      if (classEmojiObj) option.emoji = classEmojiObj;
      options.push(option);
    }

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-task:char-filter")
        .setPlaceholder(t("raid-status.taskView.charFilterPlaceholder", lang))
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  function buildBulkTaskToggleRow(disabled) {
    const aggregates = aggregateTasksOnPage();
    if (aggregates.length === 0) {
      return buildEmptyToggleRow({
        placeholder: t("raid-status.taskView.noTaskAccountPlaceholder", lang),
      });
    }

    const options = aggregates.slice(0, 25).map((aggregate) => {
      const allDone = aggregate.doneCount === aggregate.owners.length;
      const icon = allDone ? UI.icons.done : UI.icons.pending;
      return {
        label: truncateText(
          `${icon} ${aggregate.name} \u00B7 ${aggregate.reset} (${aggregate.doneCount}/${aggregate.owners.length})`,
          100
        ),
        value: `__all__::${aggregate.reset}::${aggregate.name.trim().toLowerCase()}`.slice(0, 100),
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-task:toggle")
        .setPlaceholder(t("raid-status.taskView.bulkTogglePlaceholder", lang))
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  function buildCharacterTaskToggleRow(disabled, activeName) {
    const account = getAccounts()[getCurrentPage()];
    const character = (account?.characters || []).find(
      (candidate) =>
        getCharacterName(candidate).trim().toLowerCase() ===
        activeName.trim().toLowerCase()
    );
    const sideTasks =
      character && Array.isArray(character.sideTasks)
        ? character.sideTasks
        : [];

    if (sideTasks.length === 0) {
      return buildEmptyToggleRow({
        placeholder: t("raid-status.taskView.charNoTaskPlaceholder", lang, {
          name: activeName,
        }),
      });
    }

    const options = sideTasks.slice(0, 25).map((task) => {
      const icon = task.completed ? UI.icons.done : UI.icons.pending;
      return {
        label: truncateText(`${icon} ${task.name} \u00B7 ${task.reset}`, 100),
        value: `${activeName}::${task.taskId}`.slice(0, 100),
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-task:toggle")
        .setPlaceholder(
          t("raid-status.taskView.charTogglePlaceholder", lang, {
            name: activeName,
          })
        )
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  function buildTaskToggleRow(disabled) {
    const activeName = resolveTaskCharFilter();
    if (!activeName) {
      return buildEmptyToggleRow({
        placeholder: t("raid-status.taskView.noTaskPlaceholder", lang),
      });
    }
    if (activeName === ALL_CHARS_SENTINEL) {
      return buildBulkTaskToggleRow(disabled);
    }
    return buildCharacterTaskToggleRow(disabled, activeName);
  }

  return {
    buildTaskCharFilterRow,
    buildTaskToggleRow,
  };
}

module.exports = {
  createTaskToggleRows,
  parseCustomEmoji,
};
