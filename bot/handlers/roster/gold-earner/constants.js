"use strict";

const { GOLD_EARNER_CAP_PER_ACCOUNT } = require("../../../utils/raid/common/character");
const {
  SESSION_TTL_MS,
  PICKER_MAX_OPTIONS,
  BUTTONS_PER_ROW,
} = require("../picker/constants");

const CHECK_ICON = "\uD83D\uDCB0";
const UNCHECK_ICON = "\u2B1C";

module.exports = {
  SESSION_TTL_MS,
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
  BUTTONS_PER_ROW,
  CHECK_ICON,
  UNCHECK_ICON,
};
