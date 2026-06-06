"use strict";

function createSharedTaskToggleRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UI,
  truncateText,
  lang,
  getAccounts,
  getCurrentPage,
  getVisibleSharedTasks,
  getSharedTaskDisplay,
  t,
}) {
  return function buildSharedTaskToggleRow(disabled) {
    const account = getAccounts()[getCurrentPage()];
    const now = new Date();
    const sharedTasks = getVisibleSharedTasks(account, now.getTime()).filter((task) => {
      const display = getSharedTaskDisplay(task, now, lang);
      return task?.reset !== "scheduled" || display.active;
    });
    if (sharedTasks.length === 0) return null;

    const options = sharedTasks.slice(0, 25).map((task) => {
      const display = getSharedTaskDisplay(task, now, lang);
      const icon = display.completed ? UI.icons.done : UI.icons.pending;
      return {
        label: truncateText(
          `${icon} ${display.name} \u00B7 ${display.optionStatus || display.status}`,
          100
        ),
        value: `shared::${task.taskId}`.slice(0, 100),
        emoji: display.emoji,
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-task:shared-toggle")
        .setPlaceholder(t("raid-status.taskView.sharedTogglePlaceholder", lang))
        .setDisabled(disabled)
        .addOptions(options)
    );
  };
}

module.exports = { createSharedTaskToggleRow };
