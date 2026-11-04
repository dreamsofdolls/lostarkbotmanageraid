/**
 * services/raid/channel-monitor/channel-monitor-parser.js
 * Pure parser for short raid-clear messages posted in the configured raid
 * monitor channel. Keep this free of Discord/Mongo dependencies so parser
 * aliases can be tested without constructing the channel-monitor service.
 */

"use strict";

const {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  JP_MODE_ALIASES,
  buildModeAliasMap,
} = require("../../../domain/difficulty-aliases");

const RAID_ALIASES = new Map([
  ["armoche", "armoche"],
  ["act4", "armoche"],
  ["kazeros", "kazeros"],
  ["kaz", "kazeros"],
  ["final", "kazeros"],
  ["serca", "serca"],
  ["secra", "serca"],
  ["horizon", "horizon"],
  ["cathedral", "horizon"],
  ["hc", "horizon"],
  ["belgardin", "belgardin"],
  ["belg", "belgardin"],
  // Native JP raid names. Token lower-casing does not affect katakana, so exact
  // aliases are enough once separator normalization has run.
  ["アクト4", "armoche"],
  ["カゼロス", "kazeros"],
  ["セルカ", "serca"],
]);

// Tokens never hold a space, so the spaced forms ("level 1", "solo mode")
// never match here; normalizeRaidChannelContent folds "level 1" into "level1".
const DIFFICULTY_ALIASES = buildModeAliasMap(
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  JP_MODE_ALIASES
);

// `done` takes the mode's place and marks the raid done in the mode each
// character already has, so it never carries a difficulty of its own.
const ACTION_ALIASES = new Map([
  ["reset", "reset"],
  ["rs", "reset"],
  ["done", "done"],
]);

const GATE_TOKEN_RE = /^g([1-9])$/;
// User (<@id>, <@!id>), role (<@&id>) and channel (<#id>) mention markup.
// None of it can be a raid, difficulty or character name, so a post that
// tags someone must parse exactly like the same post without the tag.
const MENTION_RE = /<(?:@[!&]?|#)\d+>/g;

function normalizeRaidChannelContent(content) {
  return String(content || "")
    .replace(MENTION_RE, " ")
    .trim()
    .replace(/act\s+4/gi, "act4")
    .replace(/horizon\s+cathedral/gi, "horizon")
    .replace(/\blevel\s*1\b/gi, "level1")
    .replace(/\blevel\s*2\b/gi, "level2")
    .replace(/\blevel\s*3\b/gi, "level3")
    .replace(/[+,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Directive mixes a message may not combine, in the order they are reported:
// the first rule that matches is the error the poster sees.
const DIRECTIVE_REJECTIONS = Object.freeze([
  { when: (p) => p.lateRaids.length > 0, error: (p) => ({ error: "raid-after-mode", raids: [...new Set(p.lateRaids)] }) },
  { when: (p) => p.diffSet.size > 1, error: (p) => ({ error: "multi-difficulty", difficulties: [...p.diffSet] }) },
  { when: (p) => p.gateSet.size > 1, error: (p) => ({ error: "multi-gate", gates: [...p.gateSet] }) },
  { when: (p) => p.actionSet.size > 1, error: () => ({ error: "done-with-reset" }) },
  { when: (p) => p.action === "reset" && p.diffSet.size > 0, error: () => ({ error: "reset-with-difficulty" }) },
  { when: (p) => p.action === "reset" && p.gateSet.size > 0, error: () => ({ error: "reset-with-gate" }) },
  { when: (p) => p.action === "done" && p.diffSet.size > 0, error: () => ({ error: "done-with-difficulty" }) },
]);

/**
 * Parse a raid monitor message into a raid-set intent.
 * @param {string} content
 * @returns {null|object}
 */
function parseRaidMessage(content) {
  const normalized = normalizeRaidChannelContent(content);
  if (!normalized) return null;
  const tokens = normalized.toLowerCase().split(" ").filter(Boolean);
  if (tokens.length < 3) return null;

  const directiveIndex = tokens.findIndex(
    (tok) => DIFFICULTY_ALIASES.has(tok) || ACTION_ALIASES.has(tok)
  );
  if (directiveIndex <= 0) return null;

  const raidSet = new Set();
  const diffSet = new Set();
  const gateSet = new Set();
  const actionSet = new Set();
  const leftover = [];
  const invalidRaids = [];
  const lateRaids = [];
  const raidDisplayNames = {};

  for (const tok of tokens.slice(0, directiveIndex)) {
    const raidKey = RAID_ALIASES.get(tok);
    if (raidKey) {
      raidSet.add(raidKey);
      if (tok === "final") raidDisplayNames[raidKey] = "Final";
    } else {
      invalidRaids.push(tok);
    }
  }

  if (invalidRaids.length > 0 || raidSet.size === 0) {
    // `done` is common in chat ("all done thanks"); with no raid named before
    // it, the post is chat, not a clear with a mistyped raid.
    if (raidSet.size === 0 && ACTION_ALIASES.get(tokens[directiveIndex]) === "done") return null;
    return {
      error: "invalid-raid",
      raids: [...new Set(invalidRaids.length > 0
        ? invalidRaids
        : tokens.slice(0, directiveIndex))],
    };
  }

  for (const tok of tokens.slice(directiveIndex)) {
    if (RAID_ALIASES.has(tok)) {
      lateRaids.push(tok);
      continue;
    }
    if (DIFFICULTY_ALIASES.has(tok)) {
      diffSet.add(DIFFICULTY_ALIASES.get(tok));
      continue;
    }
    if (ACTION_ALIASES.has(tok)) {
      actionSet.add(ACTION_ALIASES.get(tok));
      continue;
    }
    const gateMatch = tok.match(GATE_TOKEN_RE);
    if (gateMatch) {
      gateSet.add(`G${gateMatch[1]}`);
      continue;
    }
    leftover.push(tok);
  }

  if (leftover.length === 0) return null;
  const action = [...actionSet][0] || null;
  const parsed = { lateRaids, diffSet, gateSet, actionSet, action };
  const rejection = DIRECTIVE_REJECTIONS.find((rule) => rule.when(parsed));
  if (rejection) return rejection.error(parsed);
  // With no action, only a difficulty makes the message a clear.
  if (!action && diffSet.size === 0) return null;

  const raidKeys = [...raidSet];
  return {
    ...(raidKeys.length === 1 ? { raidKey: raidKeys[0] } : { raidKeys }),
    ...(Object.keys(raidDisplayNames).length > 0 ? { raidDisplayNames } : {}),
    modeKey: [...diffSet][0] || null,
    ...(action ? { action } : {}),
    charNames: [...new Set(leftover.filter(Boolean))],
    gate: [...gateSet][0] || null,
  };
}

module.exports = {
  normalizeRaidChannelContent,
  parseRaidMessage,
};
