"use strict";

const ROSTER_PICKER_ACTION = Object.freeze({
  toggle: "toggle",
  cancel: "cancel",
  confirm: "confirm",
});

function parseRosterPickerCustomId(customId) {
  const parts = String(customId || "").split(":");
  return {
    prefix: parts[0] || "",
    action: parts[1] || "",
    sessionId: parts[2] || "",
    indexText: parts[3] || "",
    parts,
  };
}

function getRosterPickerRoute(customId, { prefix } = {}) {
  const parsed = parseRosterPickerCustomId(customId);
  if (prefix && parsed.prefix !== prefix) return null;

  const action = ROSTER_PICKER_ACTION[parsed.action];
  if (!action) return null;

  const route = {
    prefix: parsed.prefix,
    action,
    sessionId: parsed.sessionId,
  };

  if (action === ROSTER_PICKER_ACTION.toggle) {
    const index = Number(parsed.indexText);
    route.index = Number.isInteger(index) ? index : null;
  }

  return route;
}

module.exports = {
  ROSTER_PICKER_ACTION,
  getRosterPickerRoute,
  parseRosterPickerCustomId,
};
