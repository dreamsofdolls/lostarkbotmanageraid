"use strict";

const { isSoloModeKey } = require("../../domain/raid-catalog");

function isRaidCheckVisibleMode(modeKey) {
  return !isSoloModeKey(modeKey);
}

// /raid-check is a group-planning surface. Solo modes and raids outside the
// character's three active gold slots (rendered with 🔒 in /raid-status) do
// not belong in its cards, filters, or pending totals. Bare catalogue/event
// entries have no goldReceives flag and therefore remain visible.
function isRaidCheckVisibleRaid(raid) {
  return isRaidCheckVisibleMode(raid?.modeKey) && raid?.goldReceives !== false;
}

function filterRaidCheckRequirementMap(requirementMap) {
  return Object.fromEntries(
    Object.entries(requirementMap || {})
      .filter(([, entry]) => isRaidCheckVisibleRaid(entry))
  );
}

module.exports = {
  filterRaidCheckRequirementMap,
  isRaidCheckVisibleMode,
  isRaidCheckVisibleRaid,
};
