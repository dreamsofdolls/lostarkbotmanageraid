"use strict";

const { getRaidModeLabel } = require("../../../utils/raid/common/labels");

const GOLD_RECEIVE_ICON = "\uD83D\uDCB0";
// Raid visibility rows: a shown raid and a hidden one. Both are emoji so the
// two states line up at one size; the circles already mean raid progress and
// \u2796 means "will be removed" on the roster edit card. The locales' all-hidden
// line repeats the hidden icon.
const RAID_SHOWN_ICON = "\u{1F539}";
const RAID_HIDDEN_ICON = "\u{1F4A4}";

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
  RAID_HIDDEN_ICON,
  RAID_SHOWN_ICON,
  localizedRaidLabel,
  rawGoldTotal,
};
