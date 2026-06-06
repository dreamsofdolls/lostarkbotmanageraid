"use strict";

const RAID_CHECK_BUTTON_SCOPE = Object.freeze({
  self: "self",
  manager: "manager",
  raid: "raid",
});

const RAID_CHECK_BUTTON_HANDLER = Object.freeze({
  disableAutoSelf: "disableAutoSelf",
  enableAutoSelf: "enableAutoSelf",
  editAll: "editAll",
  enableAutoOne: "enableAutoOne",
  disableAutoOne: "disableAutoOne",
  viewTasks: "viewTasks",
  sync: "sync",
  edit: "edit",
  unsupported: "unsupported",
});

const SELF_ACTION_HANDLERS = Object.freeze({
  "disable-auto-self": RAID_CHECK_BUTTON_HANDLER.disableAutoSelf,
  "enable-auto-self": RAID_CHECK_BUTTON_HANDLER.enableAutoSelf,
});

const MANAGER_ACTION_HANDLERS = Object.freeze({
  "edit-all": RAID_CHECK_BUTTON_HANDLER.editAll,
  "enable-auto-one": RAID_CHECK_BUTTON_HANDLER.enableAutoOne,
  "disable-auto-one": RAID_CHECK_BUTTON_HANDLER.disableAutoOne,
  "view-tasks": RAID_CHECK_BUTTON_HANDLER.viewTasks,
});

const RAID_ACTION_HANDLERS = Object.freeze({
  sync: RAID_CHECK_BUTTON_HANDLER.sync,
  edit: RAID_CHECK_BUTTON_HANDLER.edit,
});

function parseRaidCheckButtonCustomId(customId) {
  const parts = String(customId || "").split(":");
  return {
    prefix: parts[0] || "",
    action: parts[1] || "",
    value: parts[2] || "",
    parts,
  };
}

function getRaidCheckButtonRoute(customId) {
  const parsed = parseRaidCheckButtonCustomId(customId);
  const action = parsed.action;
  const selfHandler = SELF_ACTION_HANDLERS[action];
  if (selfHandler) {
    return {
      scope: RAID_CHECK_BUTTON_SCOPE.self,
      handler: selfHandler,
      action,
      targetDiscordId: parsed.value || null,
      managerRequired: false,
      raidRequired: false,
    };
  }

  const managerHandler = MANAGER_ACTION_HANDLERS[action];
  if (managerHandler) {
    return {
      scope: RAID_CHECK_BUTTON_SCOPE.manager,
      handler: managerHandler,
      action,
      targetDiscordId: parsed.value || null,
      preSelectedUserId: action === "edit-all" ? parsed.value || null : null,
      managerRequired: true,
      raidRequired: false,
    };
  }

  return {
    scope: RAID_CHECK_BUTTON_SCOPE.raid,
    handler: RAID_ACTION_HANDLERS[action] || RAID_CHECK_BUTTON_HANDLER.unsupported,
    action,
    raidKey: parsed.value || "",
    managerRequired: true,
    raidRequired: true,
  };
}

module.exports = {
  RAID_CHECK_BUTTON_HANDLER,
  RAID_CHECK_BUTTON_SCOPE,
  getRaidCheckButtonRoute,
  parseRaidCheckButtonCustomId,
};
