"use strict";

const {
  ALL_MODE_AUTO_SYNC_ACTION,
  resolveAllModeAutoSyncAction,
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

/** Build the manager action that syncs all opted-in rosters across all raids. */
function buildSyncAllButton({ ButtonBuilder, ButtonStyle, t, lang, disabled }) {
  return createButton({
    ButtonBuilder,
    customId: "raid-check:sync-all",
    label: t("raid-check.buttons.syncAll", lang),
    emoji: "🔄",
    style: ButtonStyle.Primary,
    disabled,
  });
}

function addAllModeActionButtons({
  row,
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
  currentViewUserId,
  actionUserId,
  autoManageStateByDiscordId,
  localSyncStateByDiscordId,
}) {
  if (!currentViewUserId) return row;
  const autoSyncButton = buildAutoSyncButton({
    ButtonBuilder,
    ButtonStyle,
    t,
    lang,
    disabled,
    actionUserId,
    action: resolveAllModeAutoSyncAction({
      actionUserId,
      autoManageStateByDiscordId,
      localSyncStateByDiscordId,
    }),
  });
  if (autoSyncButton) row.addComponents(autoSyncButton);
  return row;
}

module.exports = {
  addAllModeActionButtons,
  buildRosterRefreshButton,
  buildSyncAllButton,
};
