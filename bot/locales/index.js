// Aggregator for the RaidManage locale packs. Service code (i18n.js,
// handlers) only imports from this file - that lets us swap to a
// folder-per-locale layout (vi/index.js, vi/share.js, vi/raid-help.js)
// later without touching every consumer.
//
// SUPPORTED_LANGUAGES drives the /raid-language picker. Every entry
// here is a "first-class" locale with full Artist-voice coverage
// across every command. As of 2026-05-09 that's vi (default), jp, en.
// New locales added here only need a matching <code>.js file; the
// picker, /raid-help language: option, and per-user persistence pick
// them up automatically.
//
// To add a first-class language:
//   1. Create bot/locales/<code>.js mirroring vi.js's full tree
//   2. Require + add to TRANSLATIONS below
//   3. Append to SUPPORTED_LANGUAGES (visible in /raid-language picker)
//   4. test/i18n.test.js will fail until the vi→<code> key parity holds
"use strict";

const vi = require("./vi");
const jp = require("./jp");
const en = require("./en");

const TRANSLATIONS = { vi, jp, en };

// Order here drives the /raid-language picker option order.
const SUPPORTED_LANGUAGES = [
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
  { code: "jp", label: "日本語", flag: "🇯🇵" },
  { code: "en", label: "English", flag: "🇬🇧" },
];

const DEFAULT_LANGUAGE = "vi";

module.exports = {
  TRANSLATIONS,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
};
