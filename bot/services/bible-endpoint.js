"use strict";

// Single source for the lostark.bible endpoint every service must agree
// on. User agents stay per-caller on purpose: the roster fetch presents a
// browser UA (the site serves a different shell otherwise), while the log
// client identifies the bot.
const BIBLE_ORIGIN = "https://lostark.bible";
const BIBLE_REGION = "NA";
const BIBLE_REQUEST_TIMEOUT_MS = 15000;

module.exports = {
  BIBLE_ORIGIN,
  BIBLE_REGION,
  BIBLE_REQUEST_TIMEOUT_MS,
};
