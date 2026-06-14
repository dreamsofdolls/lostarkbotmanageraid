"use strict";

const {
  ALL_MODE_AUTO_SYNC_ACTION,
  resolveAllModeAutoSyncAction,
  resolveAllModeViewToggleTarget,
} = require("./all-mode-actions");

function createButton({
  ButtonBuilder,
  customId,
  label,
  emoji,
  style,
  disabled,
}) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(disabled);
}

function buildEditButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
  currentViewUserId,
}) {
  return createButton({
    ButtonBuilder,
    customId: `raid-check:edit-all:${currentViewUserId}`,
    label: t("raid-check.buttons.editProgress", lang),
    emoji: "\u270f\ufe0f",
    style: ButtonStyle.Secondary,
    disabled,
  });
}

function buildAutoSyncButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
  actionUserId,
  action,
}) {
  const configs = {
    [ALL_MODE_AUTO_SYNC_ACTION.enable]: {
      customId: `raid-check:enable-auto-one:${actionUserId}`,
      label: t("raid-check.buttons.enableAutoSync", lang),
      emoji: "\u{1f504}",
      style: ButtonStyle.Primary,
    },
    [ALL_MODE_AUTO_SYNC_ACTION.disable]: {
      customId: `raid-check:disable-auto-one:${actionUserId}`,
      label: t("raid-check.buttons.disableAutoSync", lang),
      emoji: "\u{1f6ab}",
      style: ButtonStyle.Secondary,
    },
  };
  const config = configs[action];
  if (!config) return null;
  return createButton({ ButtonBuilder, disabled, ...config });
}

function buildViewToggleButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
  targetView,
}) {
  const configs = {
    task: {
      customId: "raid-check-all:view-toggle:task",
      label: t("raid-check.buttons.viewTasks", lang),
      emoji: "\u{1f4dd}",
      style: ButtonStyle.Secondary,
    },
    raid: {
      customId: "raid-check-all:view-toggle:raid",
      label: t("raid-check.buttons.backToRaidScan", lang),
      emoji: "\u{1f4cb}",
      style: ButtonStyle.Primary,
    },
  };
  return createButton({ ButtonBuilder, disabled, ...configs[targetView] });
}

function buildRosterRefreshButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
}) {
  return createButton({
    ButtonBuilder,
    customId: "raid-check-all:roster-refresh",
    label: t("raid-check.buttons.refreshRoster", lang),
    emoji: "\u{1f504}",
    style: ButtonStyle.Secondary,
    disabled,
  });
}

function buildAllModeRosterRefreshRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
}) {
  return new ActionRowBuilder().addComponents(
    buildRosterRefreshButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      disabled,
    })
  );
}

function addAllModeActionButtons({
  row,
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
  currentView,
  currentViewUserId,
  actionUserId,
  autoManageStateByDiscordId,
  localSyncStateByDiscordId,
}) {
  if (currentView === "raid") {
    row.addComponents(
      buildEditButton({
        ButtonBuilder,
        ButtonStyle,
        t,
        lang,
        disabled,
        currentViewUserId,
      })
    );

    const autoSyncAction = resolveAllModeAutoSyncAction({
      actionUserId,
      autoManageStateByDiscordId,
      localSyncStateByDiscordId,
    });
    const autoSyncButton = buildAutoSyncButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      disabled,
      actionUserId,
      action: autoSyncAction,
    });
    if (autoSyncButton) row.addComponents(autoSyncButton);
  }

  if (actionUserId) {
    row.addComponents(
      buildViewToggleButton({
        ButtonBuilder,
        ButtonStyle,
        t,
        lang,
        disabled,
        targetView: resolveAllModeViewToggleTarget(currentView),
      })
    );
  }
  return row;
}

module.exports = {
  addAllModeActionButtons,
  buildAllModeRosterRefreshRow,
  buildAutoSyncButton,
  buildRosterRefreshButton,
  buildViewToggleButton,
};
