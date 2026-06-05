"use strict";

function parseScheduleCustomId(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== "rse" || parts.length < 3) return null;
  return {
    eventId: parts[parts.length - 1],
    action: parts.slice(1, -1).join(":"),
  };
}

function resolveScheduleActionHandler(action, exactHandlers, prefixedHandlers = []) {
  if (!action) return null;
  if (Object.prototype.hasOwnProperty.call(exactHandlers, action)) {
    return exactHandlers[action];
  }
  const prefixed = prefixedHandlers.find(({ prefix }) => action.startsWith(prefix));
  return prefixed ? prefixed.create(action) : null;
}

module.exports = {
  parseScheduleCustomId,
  resolveScheduleActionHandler,
};
