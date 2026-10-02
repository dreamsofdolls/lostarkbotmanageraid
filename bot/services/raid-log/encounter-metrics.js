"use strict";

const JSON5 = require("json5");
const { isSupportClass } = require("../../models/Class");

const MAX_ENCOUNTER_LENGTH = 8 * 1024 * 1024;

/**
 * Runs in the page. Svelte embeds public encounter data as an object literal,
 * not JSON. Extract only that object; never execute the bootstrap script.
 * @param {number} maxLength maximum accepted inline script length
 * @returns {string|null} embedded encounter literal
 */
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
    let comment = "";
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
      } else if (comment === "line") {
        if (char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029") comment = "";
      } else if (comment === "block") {
        if (char === "*" && source[index + 1] === "/") { comment = ""; index++; }
      } else if (char === "/" && source[index + 1] === "/") {
        comment = "line";
        index++;
      } else if (char === "/" && source[index + 1] === "*") {
        comment = "block";
        index++;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function syntaxError() {
  return new SyntaxError("Invalid embedded encounter data");
}

// Keep large non-support payloads as source ranges. JSON5 parses only the
// identity and contribution scalars needed for the public figures.
function skipTrivia(source, start, limit) {
  let index = start;
  while (index < limit) {
    if (/[\s\u00a0\ufeff]/u.test(source[index])) { index++; continue; }
    if (source[index] !== "/") break;
    if (source[index + 1] === "/") {
      index += 2;
      while (index < limit && !/[\n\r\u2028\u2029]/u.test(source[index])) index++;
      continue;
    }
    if (source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0 || end >= limit) throw syntaxError();
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function quotedEnd(source, start, limit) {
  const quote = source[start];
  for (let index = start + 1; index < limit; index++) {
    const char = source[index];
    if (char === quote) return index + 1;
    if (char === "\n" || char === "\r") throw syntaxError();
    if (char === "\\") {
      index++;
      if (index >= limit) throw syntaxError();
      const escaped = source[index];
      if (/[1-9]/.test(escaped) || (escaped === "0" && /\d/.test(source[index + 1]))) throw syntaxError();
      if (escaped === "x" || escaped === "u") {
        const digits = escaped === "x" ? 2 : 4;
        for (let offset = 1; offset <= digits; offset++) {
          if (!/[0-9a-f]/i.test(source[index + offset])) throw syntaxError();
        }
        index += digits;
      } else if (escaped === "\r" && source[index + 1] === "\n") index++;
    }
  }
  throw syntaxError();
}

function compositeEnd(source, start, limit) {
  const closing = [source[start] === "{" ? "}" : "]"];
  for (let index = start + 1; index < limit; index++) {
    const char = source[index];
    if (char === '"' || char === "'") { index = quotedEnd(source, index, limit) - 1; continue; }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipTrivia(source, index, limit) - 1;
      continue;
    }
    if (char === "{" || char === "[") closing.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (closing.pop() !== char) throw syntaxError();
      if (!closing.length) return index + 1;
    }
  }
  throw syntaxError();
}

function valueEnd(source, start, limit) {
  const index = skipTrivia(source, start, limit);
  const char = source[index];
  if (char === '"' || char === "'") return quotedEnd(source, index, limit);
  if (char === "{" || char === "[") return compositeEnd(source, index, limit);
  let end = index;
  while (end < limit && !/[\s,}\]\u00a0\ufeff]/u.test(source[end])) {
    if (source[end] === "/") break;
    end++;
  }
  if (end === index) throw syntaxError();
  JSON5.parse(source.slice(index, end));
  return end;
}

function propertyName(source, start, limit) {
  if (source[start] === '"' || source[start] === "'") {
    const end = quotedEnd(source, start, limit);
    return { name: JSON5.parse(source.slice(start, end)), end };
  }
  let end = start;
  while (end < limit && !/[\s:\u00a0\ufeff]/u.test(source[end])) {
    if (source[end] === "/") break;
    end++;
  }
  if (end === start) throw syntaxError();
  const holder = JSON5.parse("{" + source.slice(start, end) + ":null}");
  return { name: Object.keys(holder)[0], end };
}

function validateValue(source, start, limit) {
  let index = skipTrivia(source, start, limit);
  const opening = source[index];
  if (opening === '"' || opening === "'") return quotedEnd(source, index, limit);
  if (opening !== "{" && opening !== "[") return valueEnd(source, index, limit);
  const closing = opening === "{" ? "}" : "]";
  index = skipTrivia(source, index + 1, limit);
  while (index < limit && source[index] !== closing) {
    if (opening === "{") {
      const property = propertyName(source, index, limit);
      index = skipTrivia(source, property.end, limit);
      if (source[index++] !== ":") throw syntaxError();
    }
    index = validateValue(source, index, limit);
    index = skipTrivia(source, index, limit);
    if (source[index] === closing) return index + 1;
    if (source[index++] !== ",") throw syntaxError();
    index = skipTrivia(source, index, limit);
  }
  if (source[index] !== closing) throw syntaxError();
  return index + 1;
}

function objectProperties(source, range) {
  const start = skipTrivia(source, range.start, range.end);
  if (source[start] !== "{") return null;
  const end = source[range.end - 1] === "}" ? range.end : compositeEnd(source, start, range.end);
  if (end !== range.end && skipTrivia(source, end, range.end) !== range.end) throw syntaxError();
  const properties = new Map();
  let index = skipTrivia(source, start + 1, end - 1);
  while (index < end - 1) {
    const property = propertyName(source, index, end - 1);
    index = skipTrivia(source, property.end, end - 1);
    if (source[index++] !== ":") throw syntaxError();
    const valueStart = skipTrivia(source, index, end - 1);
    const valueFinish = valueEnd(source, valueStart, end - 1);
    properties.set(property.name, { start: valueStart, end: valueFinish });
    index = skipTrivia(source, valueFinish, end - 1);
    if (index === end - 1) break;
    if (source[index++] !== ",") throw syntaxError();
    index = skipTrivia(source, index, end - 1);
  }
  return properties;
}

function arrayValues(source, range) {
  const start = skipTrivia(source, range.start, range.end);
  if (source[start] !== "[") return null;
  const end = source[range.end - 1] === "]" ? range.end : compositeEnd(source, start, range.end);
  if (end !== range.end && skipTrivia(source, end, range.end) !== range.end) throw syntaxError();
  const values = [];
  let index = skipTrivia(source, start + 1, end - 1);
  while (index < end - 1) {
    const valueFinish = valueEnd(source, index, end - 1);
    values.push({ start: index, end: valueFinish });
    index = skipTrivia(source, valueFinish, end - 1);
    if (index === end - 1) break;
    if (source[index++] !== ",") throw syntaxError();
    index = skipTrivia(source, index, end - 1);
  }
  return values;
}

function parseRange(source, range) {
  return JSON5.parse(source.slice(range.start, range.end));
}

function collectionValues(source, range) {
  const properties = objectProperties(source, range);
  return properties ? [...properties.values()] : arrayValues(source, range);
}

function buffedDamage(source, skillRange) {
  const skills = collectionValues(source, skillRange);
  if (!skills) return NaN;
  let total = 0;
  for (const range of skills) {
    const contributionRange = objectProperties(source, range)?.get("rdpsContributed");
    if (!contributionRange) continue;
    const contributionObject = objectProperties(source, contributionRange);
    const contributionArray = contributionObject ? null : arrayValues(source, contributionRange);
    const contributionPrimitive = contributionObject || contributionArray ? null : parseRange(source, contributionRange);
    for (const type of [1, 3, 5]) {
      const valueRange = contributionObject?.get(String(type)) ?? contributionArray?.[type];
      const contribution = valueRange ? parseRange(source, valueRange) : (contributionPrimitive?.[type] ?? 0);
      total += typeof contribution === "number" && contribution >= 0 ? contribution : NaN;
    }
  }
  return total;
}

/**
 * @param {string} literal embedded public encounter object
 * @param {{ logId: string, summary: string, players: object[] }} options capture identity and players
 * @returns {Map<string, number>} buffed-damage percentages keyed by player slot
 */
function supportSharesFromEncounter(literal, { logId, summary, players }) {
  if (typeof literal !== "string" || literal.length > MAX_ENCOUNTER_LENGTH) return new Map();
  const validatedEnd = validateValue(literal, 0, literal.length);
  if (skipTrivia(literal, validatedEnd, literal.length) !== literal.length) throw syntaxError();
  // The displayed total includes Esther damage when Bible's setting is on.
  // encounterDamageStats.totalDamageDealt alone would inflate bD% in that case.
  const total = Number(/Total DMG:\s*([\d,]+)(?=\s|$)/.exec(summary || "")?.[1]?.replace(/,/g, ""));
  if (!(total > 0) || !Number.isFinite(total)) return new Map();
  const root = objectProperties(literal, { start: 0, end: literal.length });
  if (!root?.has("id") || !root.has("encounter") || parseRange(literal, root.get("id")) !== logId) return new Map();
  const encounter = objectProperties(literal, root.get("encounter"));
  const entities = encounter?.has("entityList") && arrayValues(literal, encounter.get("entityList"));
  if (!entities) return new Map();
  const normalizeClass = value => String(value || "").replace(/\s/g, "").toLowerCase();
  const targets = players.filter(entry => isSupportClass(entry.className)).map(player => ({
    player, name: player.label.replace(/^\d{4}(?:\.\d+)?\s+/, ""),
    className: normalizeClass(player.className), matches: 0, skills: null,
  }));
  for (const range of entities) {
    const entity = objectProperties(literal, range);
    if (!entity?.has("entityType") || !entity.has("name") || !entity.has("class")) continue;
    const type = parseRange(literal, entity.get("entityType"));
    const name = parseRange(literal, entity.get("name"));
    const className = normalizeClass(parseRange(literal, entity.get("class")));
    const matches = type === "PLAYER"
      ? targets.filter(target => target.name === name && target.className === className) : [];
    if (!matches.length) continue;
    for (const target of matches) {
      target.matches++;
      target.skills = entity.get("skills") ?? null;
    }
  }
  const shares = new Map();
  for (const { player, matches, skills: skillRange } of targets) {
    // Anonymous supports can share an entity id. Public name + class must
    // identify exactly one entity; never guess a slot or reveal hidden names.
    if (matches !== 1 || !skillRange) continue;
    const buffed = buffedDamage(literal, skillRange);
    // Bible sums rDPS categories 1/3/5 across the support's skills and rounds
    // the player total to one decimal. Missing contributions stay unavailable.
    if (buffed > 0 && Number.isFinite(buffed)) {
      shares.set(player.id, Number((buffed / total * 100).toFixed(1)));
    }
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
