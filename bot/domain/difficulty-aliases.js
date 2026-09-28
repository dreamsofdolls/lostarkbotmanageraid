/**
 * domain/difficulty-aliases.js
 * The words players, LOA Logs and lostark.bible use for a raid mode. Each
 * reader builds its lookup from the groups it accepts, so an alias added
 * here reaches every reader of that group instead of drifting per file.
 */

"use strict";

// Mode names and their "level N" forms. Every reader accepts these.
const CORE_MODE_ALIASES = Object.freeze({
  normal: ["normal", "level 1", "level1", "l1"],
  solo: ["solo", "solo mode"],
  hard: ["hard", "level 2", "level2", "l2"],
  nightmare: ["nightmare", "level 3", "level3", "l3"],
});

// Shorthand from the VN community. `nm` reads as "nor-mal" there, so
// Nightmare keeps `9m` as its only shorthand.
const SHORTHAND_MODE_ALIASES = Object.freeze({
  normal: ["nor", "nm"],
  hard: ["hm"],
  nightmare: ["9m"],
});

// Native JP mode names typed in the raid channel.
const JP_MODE_ALIASES = Object.freeze({
  normal: ["ノーマル"],
  solo: ["ソロ"],
  hard: ["ハード"],
  nightmare: ["ナイトメア"],
});

// Older LOA Logs versions wrote Nightmare clears as Trial, then Inferno.
const LOA_LOGS_MODE_ALIASES = Object.freeze({
  nightmare: ["trial", "inferno"],
});

/**
 * Build a lower-case alias → mode key lookup from alias groups.
 * Throws when two groups send one alias to different modes.
 * @param {...Object<string, string[]>} groups - mode key → aliases
 * @returns {Map<string, string>}
 */
function buildModeAliasMap(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const [modeKey, aliases] of Object.entries(group)) {
      for (const alias of aliases) {
        const existing = map.get(alias);
        if (existing && existing !== modeKey) {
          throw new Error(`Difficulty alias "${alias}" maps to both ${existing} and ${modeKey}`);
        }
        map.set(alias, modeKey);
      }
    }
  }
  return map;
}

module.exports = {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  JP_MODE_ALIASES,
  LOA_LOGS_MODE_ALIASES,
  buildModeAliasMap,
};
