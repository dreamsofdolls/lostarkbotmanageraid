"use strict";

const { isSoloModeKey } = require("../../domain/raid-catalog");

// The group plans its raids from 1720 (Act 4 Hard) up, so lower characters
// stay out of /raid-check's cards, counts and roster pages.
const RAID_CHECK_MIN_ITEM_LEVEL = 1720;

function isRaidCheckVisibleMode(modeKey) {
  return !isSoloModeKey(modeKey);
}

/**
 * @param {object} character - roster character
 * @returns {boolean} whether /raid-check shows this character at all
 */
function isRaidCheckVisibleCharacter(character) {
  return (Number(character?.itemLevel) || 0) >= RAID_CHECK_MIN_ITEM_LEVEL;
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
  isRaidCheckVisibleCharacter,
  isRaidCheckVisibleMode,
  isRaidCheckVisibleRaid,
};
