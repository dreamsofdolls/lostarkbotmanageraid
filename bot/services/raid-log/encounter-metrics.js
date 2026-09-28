"use strict";

const JSON5 = require("json5");
const { isSupportClass } = require("../../models/Class");

const MAX_ENCOUNTER_LENGTH = 8 * 1024 * 1024;

// Runs in the page. Svelte embeds public encounter data as an object literal,
// not JSON. Extract only that object; never execute the bootstrap script.
function readEncounterLiteral(maxLength) {
  for (const script of document.querySelectorAll("script:not([src])")) {
    const source = script.textContent || "";
    if (source.length > maxLength || !source.includes("kit.start(")) continue;
    const match = /\bencounterInfo:\s*\{/.exec(source);
    if (!match) continue;
    const start = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function supportSharesFromEncounter(literal, { logId, summary, players }) {
  if (typeof literal !== "string" || literal.length > MAX_ENCOUNTER_LENGTH) return new Map();
  const data = JSON5.parse(literal);
  const entities = data?.encounter?.entityList;
  // The displayed total includes Esther damage when Bible's setting is on.
  // encounterDamageStats.totalDamageDealt alone would inflate bD% in that case.
  const total = Number(/Total DMG:\s*([\d,]+)(?=\s|$)/.exec(summary || "")?.[1]?.replace(/,/g, ""));
  if (data?.id !== logId || !Array.isArray(entities) || !(total > 0) || !Number.isFinite(total)) return new Map();
  const normalizeClass = value => String(value || "").replace(/\s/g, "").toLowerCase();
  const shares = new Map();
  for (const player of players.filter(entry => isSupportClass(entry.className))) {
    const name = player.label.replace(/^\d{4}(?:\.\d+)?\s+/, "");
    // Anonymous supports can share an entity id. Public name + class must
    // identify exactly one entity; never guess a slot or reveal hidden names.
    const matches = entities.filter(entity => entity?.entityType === "PLAYER" && entity.name === name
      && normalizeClass(entity.class) === normalizeClass(player.className));
    if (matches.length !== 1 || !matches[0].skills || typeof matches[0].skills !== "object") continue;
    const buffed = Object.values(matches[0].skills).reduce((sum, skill) => sum + [1, 3, 5].reduce((value, type) => {
      const contribution = skill?.rdpsContributed?.[type] ?? 0;
      return value + (typeof contribution === "number" && contribution >= 0 ? contribution : NaN);
    }, 0), 0);
    // Bible sums rDPS categories 1/3/5 across the support's skills and rounds
    // the player total to one decimal. Missing contributions stay unavailable.
    if (buffed > 0 && Number.isFinite(buffed)) shares.set(player.id, Number((buffed / total * 100).toFixed(1)));
  }
  return shares;
}

async function readSupportShares(page, options) {
  const literal = await page.evaluate(readEncounterLiteral, MAX_ENCOUNTER_LENGTH);
  try {
    return supportSharesFromEncounter(literal, options);
  } catch (error) {
    options.log.warn(`[raid-log] embedded support metrics unavailable: ${error.message}`);
    return new Map();
  }
}

module.exports = { readSupportShares, readEncounterLiteral, supportSharesFromEncounter, MAX_ENCOUNTER_LENGTH };
