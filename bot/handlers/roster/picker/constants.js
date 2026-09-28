"use strict";

// Shared by the /raid-add-roster, /raid-edit-roster and /raid-gold-earner
// pickers: how long a picker stays open, how many characters it lists, and
// how many toggle buttons fit on one row.
const SESSION_TTL_MS = 5 * 60 * 1000;
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

module.exports = {
  SESSION_TTL_MS,
  PICKER_MAX_OPTIONS,
  BUTTONS_PER_ROW,
};
