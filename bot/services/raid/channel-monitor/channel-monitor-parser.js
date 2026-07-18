/**
 * services/raid/channel-monitor-parser.js
 * Pure parser for short raid-clear messages posted in the configured raid
 * monitor channel. Keep this free of Discord/Mongo dependencies so parser
 * aliases can be tested without constructing the channel-monitor service.
 */

"use strict";

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
  // Native JP raid names. Token lower-casing does not affect katakana, so exact
  // aliases are enough once separator normalization has run.
  ["アクト4", "armoche"],
  ["カゼロス", "kazeros"],
  ["セルカ", "serca"],
]);

const DIFFICULTY_ALIASES = new Map([
  ["solo", "solo"],
  ["nightmare", "nightmare"],
  ["9m", "nightmare"],
  ["level3", "nightmare"],
  ["l3", "nightmare"],
  ["hard", "hard"],
  ["hm", "hard"],
  ["level2", "hard"],
  ["l2", "hard"],
  ["normal", "normal"],
  ["nor", "normal"],
  ["level1", "normal"],
  ["l1", "normal"],
  // VN-community preference: nm reads as normal. Nightmare shorthand is 9m.
  ["nm", "normal"],
  ["ノーマル", "normal"],
  ["ソロ", "solo"],
  ["ハード", "hard"],
  ["ナイトメア", "nightmare"],
]);

const ACTION_ALIASES = new Map([
  ["reset", "reset"],
  ["rs", "reset"],
]);

const GATE_TOKEN_RE = /^g([1-9])$/;

function normalizeRaidChannelContent(content) {
  return String(content || "")
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
  if (lateRaids.length > 0) {
    return { error: "raid-after-mode", raids: [...new Set(lateRaids)] };
  }
  if (diffSet.size > 1) return { error: "multi-difficulty", difficulties: [...diffSet] };
  if (gateSet.size > 1) return { error: "multi-gate", gates: [...gateSet] };

  const action = [...actionSet][0] || null;
  if (action === "reset") {
    if (diffSet.size > 0) return { error: "reset-with-difficulty" };
    if (gateSet.size > 0) return { error: "reset-with-gate" };
  } else if (diffSet.size === 0) {
    return null;
  }

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
  ACTION_ALIASES,
  DIFFICULTY_ALIASES,
  RAID_ALIASES,
  normalizeRaidChannelContent,
  parseRaidMessage,
};
