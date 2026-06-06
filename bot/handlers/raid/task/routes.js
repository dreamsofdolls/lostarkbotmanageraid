"use strict";

const RAID_TASK_BUTTON_ACTION = Object.freeze({
  clearConfirm: "clearConfirm",
  clearCancel: "clearCancel",
});

const RAID_TASK_BUTTON_ROUTE_BUILDERS = Object.freeze({
  "clear-cancel": () => ({
    action: RAID_TASK_BUTTON_ACTION.clearCancel,
  }),
  "clear-confirm": (parsed) => {
    const hasRoster = Boolean(parsed.characterText);
    const characterText = hasRoster ? parsed.characterText : parsed.rosterText;
    return {
      action: RAID_TASK_BUTTON_ACTION.clearConfirm,
      hasRoster,
      rosterName: hasRoster ? decodeURIComponent(parsed.rosterText) : null,
      characterName: decodeURIComponent(characterText || ""),
    };
  },
});

function parseRaidTaskButtonCustomId(customId) {
  const parts = String(customId || "").split(":");
  return {
    prefix: parts[0] || "",
    action: parts[1] || "",
    rosterText: parts[2] || "",
    characterText: parts[3] || "",
    parts,
  };
}

function getRaidTaskButtonRoute(customId) {
  const parsed = parseRaidTaskButtonCustomId(customId);
  if (parsed.prefix !== "raid-task") return null;
  const buildRoute = RAID_TASK_BUTTON_ROUTE_BUILDERS[parsed.action];
  return buildRoute ? buildRoute(parsed) : null;
}

module.exports = {
  RAID_TASK_BUTTON_ACTION,
  getRaidTaskButtonRoute,
  parseRaidTaskButtonCustomId,
};
