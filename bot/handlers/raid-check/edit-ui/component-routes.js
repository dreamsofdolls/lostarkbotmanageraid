"use strict";

const RAID_CHECK_EDIT_COMPONENT_ACTION = Object.freeze({
  raid: "raid",
  user: "user",
  char: "char",
  status: "status",
  gate: "gate",
  cancel: "cancel",
});

function parseRaidCheckEditComponentCustomId(customId) {
  const parts = String(customId || "").split(":");
  return {
    prefix: parts[0] || "",
    action: parts[1] || "",
    value: parts[2] || "",
    parts,
  };
}

function getRaidCheckEditComponentRoute(customId) {
  const parsed = parseRaidCheckEditComponentCustomId(customId);
  if (parsed.prefix !== "raid-check-edit") return null;

  const handler = RAID_CHECK_EDIT_COMPONENT_ACTION[parsed.action];
  if (!handler) return null;

  const route = {
    customId: String(customId || ""),
    action: parsed.action,
    handler,
  };

  if (handler === RAID_CHECK_EDIT_COMPONENT_ACTION.status) {
    route.statusType = parsed.value || "";
  }
  if (handler === RAID_CHECK_EDIT_COMPONENT_ACTION.gate) {
    route.gate = parsed.value || "";
  }

  return route;
}

module.exports = {
  RAID_CHECK_EDIT_COMPONENT_ACTION,
  getRaidCheckEditComponentRoute,
  parseRaidCheckEditComponentCustomId,
};
