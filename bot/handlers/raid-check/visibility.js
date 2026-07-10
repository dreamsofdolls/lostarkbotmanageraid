"use strict";

const { isSoloModeKey } = require("../../models/Raid");

function isRaidCheckVisibleMode(modeKey) {
  return !isSoloModeKey(modeKey);
}

function isRaidCheckVisibleRaid(raid) {
  return isRaidCheckVisibleMode(raid?.modeKey);
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
