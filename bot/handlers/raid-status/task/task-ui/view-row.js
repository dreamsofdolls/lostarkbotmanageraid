"use strict";

function createViewToggleRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  lang,
  getCurrentView,
  t,
}) {
  return function buildViewToggleRow(disabled) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-view:toggle")
        .setPlaceholder(t("raid-status.taskView.viewTogglePlaceholder", lang))
        .setDisabled(disabled)
        .addOptions([
          {
            label: t("raid-status.taskView.viewToggleRaidLabel", lang),
            description: t("raid-status.taskView.viewToggleRaidDescription", lang),
            value: "raid",
            emoji: "\uD83D\uDCCB",
            default: getCurrentView() === "raid",
          },
          {
            label: t("raid-status.taskView.viewToggleTaskLabel", lang),
            description: t("raid-status.taskView.viewToggleTaskDescription", lang),
            value: "task",
            emoji: "\uD83D\uDCDD",
            default: getCurrentView() === "task",
          },
          {
            label: t("raid-status.taskView.viewToggleGoldLabel", lang),
            description: t("raid-status.taskView.viewToggleGoldDescription", lang),
            value: "gold",
            emoji: "\uD83D\uDCB0",
            default: getCurrentView() === "gold",
          },
          // Always listed, even with no sync mode on \u00B7 Discord cannot
          // disable a single select option, so the "off" state is shown
          // by the view itself (the console renders its disabled card
          // with no action buttons). Hiding it would cost discovery.
          {
            label: t("raid-status.taskView.viewToggleSyncLabel", lang),
            description: t("raid-status.taskView.viewToggleSyncDescription", lang),
            value: "sync",
            emoji: "\uD83D\uDDC3\uFE0F",
            default: getCurrentView() === "sync",
          },
        ])
    );
  };
}

module.exports = { createViewToggleRow };
