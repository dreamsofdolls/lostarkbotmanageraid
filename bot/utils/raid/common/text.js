/**
 * utils/raid/common/text.js
 * Name normalization, stat parsing, mode alias conversion, UTF-16-safe text
 * truncation, 2-column embed field packing, and concurrency/timeout utilities.
 */

"use strict";

const {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  buildModeAliasMap,
} = require("../../../domain/difficulty-aliases");

class ConcurrencyLimiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.active < this.max && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this._dispatch();
        });
    }
  }
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function foldName(value) {
  return normalizeName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseNumericStat(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseItemLevel(rawValue) {
  return parseNumericStat(rawValue);
}

function parseCombatScore(rawValue) {
  return parseNumericStat(rawValue);
}

const MODE_LABELS = Object.freeze({
  hard: "Hard",
  nightmare: "Nightmare",
  solo: "Solo",
});

function toModeLabel(modeKey) {
  const lower = normalizeName(modeKey);
  return MODE_LABELS[lower] || "Normal";
}

const MODE_KEYS = buildModeAliasMap(CORE_MODE_ALIASES, SHORTHAND_MODE_ALIASES);

function toModeKey(modeLabel) {
  return MODE_KEYS.get(normalizeName(modeLabel)) || "normal";
}

/**
 * Read a character's display name across current (`name`) and legacy
 * (`charName`) schemas, trimmed of surrounding whitespace.
 * @param {object|null|undefined} character
 * @returns {string}
 */
function getCharacterName(character) {
  return String(character?.name || character?.charName || "").trim();
}

function getCharacterClass(character) {
  return character?.class || character?.className || "Unknown";
}

/**
 * Read a character's class name across current (`class`) and legacy
 * (`className`) schemas, trimmed, returning an empty string when absent.
 * @param {object|null|undefined} character
 * @returns {string}
 */
function getCharacterClassOrEmpty(character) {
  return String(character?.class || character?.className || "").trim();
}

const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Cut text to a length without leaving half of a two-unit character (an
 * emoji) at the end: a lone high surrogate is not well-formed text.
 * @param {unknown} value - the text; null and undefined become ""
 * @param {number} limit - most UTF-16 units to keep
 * @returns {string} at most `limit` units, ending on a whole character
 */
function cutText(value, limit) {
  const cut = String(value ?? "").slice(0, limit);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}

function truncateText(s, max) {
  return s.length > max ? `${cutText(s, max - 3)}...` : s;
}

function formatNextCooldownRemaining(lastAttemptAt, cooldownMs) {
  const last = Number(lastAttemptAt) || 0;
  if (last <= 0 || cooldownMs <= 0) return null;
  const remaining = last + Number(cooldownMs) - Date.now();
  if (remaining <= 0) return null;

  const totalSeconds = Math.ceil(remaining / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.ceil(remaining / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

function splitEmbedFieldValue(value, limit = 1024) {
  const chunks = [];
  let current = "";
  for (const rawLine of String(value || "").split("\n")) {
    const lineParts = [];
    let remaining = rawLine;
    while (remaining.length > limit) {
      let cutAt = remaining.lastIndexOf(" ", limit);
      if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
      lineParts.push(remaining.slice(0, cutAt).trimEnd());
      remaining = remaining.slice(cutAt).trimStart();
    }
    lineParts.push(remaining);
    for (const part of lineParts) {
      const next = current ? `${current}\n${part}` : part;
      if (next.length > limit && current) {
        chunks.push(current);
        current = part;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : ["_No details_"];
}

/**
 * Split a long field value into as many fields as it needs, at line breaks
 * where possible; later fields repeat the name with a counter.
 * @param {string} name - field name
 * @param {string} value - field value, any length
 * @param {{limit?: number, inline?: boolean}} [options]
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function buildChunkedFields(name, value, { limit = 1024, inline = false } = {}) {
  return splitEmbedFieldValue(value, limit).map((chunk, index) => ({
    name: index === 0 ? name : `${name} (${index + 1})`,
    value: chunk,
    inline,
  }));
}

function addChunkedEmbedField(embed, name, value, options) {
  buildChunkedFields(name, value, options).forEach((field) => embed.addFields(field));
  return embed;
}

function waitWithBudget(promise, budgetMs) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true, value: null }), budgetMs);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}

function buildDiscordIdentityFields(source) {
  const user = source?.user || source || {};
  const member = source?.member || {};
  const username = String(user.username || "").trim();
  const globalName = String(user.globalName || "").trim();
  const memberDisplayName = String(member.displayName || member.nick || "").trim();
  const userDisplayName = String(user.displayName || globalName || username || "").trim();

  return {
    discordUsername: username,
    discordGlobalName: globalName,
    discordDisplayName: memberDisplayName || userDisplayName,
  };
}

// Frozen zero-width-space inline field used as a 2-column layout spacer.
// Discord auto-packs `inline: true` fields up to 3 per row; injecting one
// of these between every char card forces exactly 2 cards per row instead.
// Kept frozen so accidental mutation (e.g. a caller setting `.inline =
// false`) can't poison every other render that shares the reference.
const INLINE_SPACER = Object.freeze({
  name: "\u200b",
  value: "\u200b",
  inline: true,
});

/**
 * Re-pack an array of inline-true fields into a 2-column layout by
 * interleaving INLINE_SPACER between each pair. The trailing card on an
 * odd-length array gets one extra spacer so Discord doesn't stretch it
 * to full width on the last row.
 *
 * Output shape is `[A, spacer, B, C, spacer, spacer]` -
 *   row 1: A | spacer | B
 *   row 2: C | spacer | spacer
 * Discord renders 3 inline fields per row, so the spacer at index 1
 * pushes B to a new column visually inside row 1, etc.
 */
function pack2Columns(fields) {
  const out = [];
  for (let i = 0; i < fields.length; i += 2) {
    out.push(fields[i]);
    out.push(INLINE_SPACER);
    out.push(fields[i + 1] ? fields[i + 1] : INLINE_SPACER);
  }
  return out;
}

module.exports = {
  ConcurrencyLimiter,
  normalizeName,
  foldName,
  parseItemLevel,
  parseCombatScore,
  toModeLabel,
  toModeKey,
  getCharacterName,
  getCharacterClass,
  getCharacterClassOrEmpty,
  cutText,
  truncateText,
  formatNextCooldownRemaining,
  buildChunkedFields,
  addChunkedEmbedField,
  waitWithBudget,
  buildDiscordIdentityFields,
  INLINE_SPACER,
  pack2Columns,
};
