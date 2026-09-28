"use strict";

const { parseCustomIdRoute } = require("../../utils/discord/custom-id");

const RAID_CHECK_BUTTON_SCOPE = Object.freeze({
  self: "self",
  manager: "manager",
});

const RAID_CHECK_BUTTON_HANDLER = Object.freeze({
  disableAutoSelf: "disableAutoSelf",
  enableAutoSelf: "enableAutoSelf",
  enableAutoOne: "enableAutoOne",
  disableAutoOne: "disableAutoOne",
  syncAll: "syncAll",
  unsupported: "unsupported",
});

const SELF_ACTION_HANDLERS = Object.freeze({
  "disable-auto-self": RAID_CHECK_BUTTON_HANDLER.disableAutoSelf,
  "enable-auto-self": RAID_CHECK_BUTTON_HANDLER.enableAutoSelf,
});

const MANAGER_ACTION_HANDLERS = Object.freeze({
  "sync-all": RAID_CHECK_BUTTON_HANDLER.syncAll,
  "enable-auto-one": RAID_CHECK_BUTTON_HANDLER.enableAutoOne,
  "disable-auto-one": RAID_CHECK_BUTTON_HANDLER.disableAutoOne,
});

function parseRaidCheckButtonCustomId(customId) {
  return parseCustomIdRoute(customId);
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
    };
  }

  const managerHandler = MANAGER_ACTION_HANDLERS[action];
  if (managerHandler) {
    return {
      scope: RAID_CHECK_BUTTON_SCOPE.manager,
      handler: managerHandler,
      action,
      targetDiscordId: parsed.value || null,
      managerRequired: true,
    };
  }

  // Unknown actions, such as the per-raid Sync button on cards from before
  // it was removed, stay Manager-gated and get the unsupported notice.
  return {
    scope: RAID_CHECK_BUTTON_SCOPE.manager,
    handler: RAID_CHECK_BUTTON_HANDLER.unsupported,
    action,
    managerRequired: true,
  };
}

module.exports = {
  RAID_CHECK_BUTTON_HANDLER,
  RAID_CHECK_BUTTON_SCOPE,
  getRaidCheckButtonRoute,
  parseRaidCheckButtonCustomId,
};
