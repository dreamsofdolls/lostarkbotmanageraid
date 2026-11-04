"use strict";

const { getRaidModeLabel } = require("../../../utils/raid/common/labels");

const GOLD_RECEIVE_ICON = "\uD83D\uDCB0";

function localizedRaidLabel(raid, lang = "vi") {
  if (!raid) return "";
  return getRaidModeLabel(raid.raidKey, raid.modeKey, lang) ||
    raid.raidName ||
    raid.raidKey ||
    "";
}

function rawGoldTotal(raid) {
  return Number(raid?.rawTotalGold ?? raid?.totalGold) || 0;
}

module.exports = {
  GOLD_RECEIVE_ICON,
  localizedRaidLabel,
  rawGoldTotal,
};
