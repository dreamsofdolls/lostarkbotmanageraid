"use strict";

const ALL_MODE_AUTO_SYNC_ACTION = Object.freeze({
  enable: "enable",
  disable: "disable",
});

function resolveAllModeAutoSyncAction({
  actionUserId,
  autoManageStateByDiscordId,
  localSyncStateByDiscordId,
}) {
  if (!actionUserId) return null;
  if (localSyncStateByDiscordId.get(actionUserId) === true) return null;

  const optedIn = autoManageStateByDiscordId.get(actionUserId);
  if (optedIn === false) return ALL_MODE_AUTO_SYNC_ACTION.enable;
  if (optedIn === true) return ALL_MODE_AUTO_SYNC_ACTION.disable;
  return null;
}

function resolveAllModeViewToggleTarget(currentView) {
  return currentView === "raid" ? "task" : "raid";
}

module.exports = {
  ALL_MODE_AUTO_SYNC_ACTION,
  resolveAllModeAutoSyncAction,
  resolveAllModeViewToggleTarget,
};
