"use strict";

/**
 * Shared primitives for the roster / character autocomplete flows used
 * across `/raid-set`, `/raid-task`, `/remove-roster`, and `/edit-roster`.
 *
 * Each command has slightly different label format / suffix / sort
 * preference, so this module exposes building blocks rather than a
 * one-shot "handle the whole autocomplete" function. Callers wire:
 *
 *   1. `getRosterMatches(userDoc, needle)` -> filtered Account[] (≤25)
 *   2. `getCharacterMatches(userDoc, options)` -> filtered char entries
 *   3. `truncateChoice(label, value)` -> Discord choice with 100-char cap
 *
 * The shared `loadUserForAutocomplete` (in bot/commands.js) stays at the
 * call site since it depends on the User model and an in-flight dedup
 * map - this module is pure.
 */

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function getCharName(character) {
  return String(character?.name || character?.charName || "").trim();
}

function getCharClass(character) {
  return String(character?.class || character?.className || "").trim();
}

/**
 * Filter the user's accounts by an optional needle and cap to 25 (the
 * Discord StringSelectMenu / autocomplete option limit). Returns an
 * empty array if `userDoc` is unusable so callers can pipe into
 * `interaction.respond([])` cleanly.
 */
function getRosterMatches(userDoc, needle = "") {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return [];
  const target = normalizeName(needle);
  return userDoc.accounts
    .filter((a) => !target || normalizeName(a.accountName).includes(target))
    .slice(0, 25);
}

/**
 * Walk the user's accounts (optionally scoped to a single roster) and
 * collect characters matching the needle. Returns array of:
 *   { character, name, className, itemLevel, sideTaskCount }
 *
 * Options:
 *   rosterFilter:  account name to scope search to (case-insensitive,
 *                  null/empty = every account)
 *   needle:        substring filter on char name (case-insensitive)
 *   dedup:         drop chars with same name across different accounts
 *                  (default true - matches /raid-set behavior)
 *   sortByILvl:    sort iLvl desc, name asc tiebreak (default true)
 *   limit:         cap result count (default 25)
 */
function getCharacterMatches(userDoc, options = {}) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return [];
  const {
    rosterFilter = null,
    needle = "",
    dedup = true,
    sortByILvl = true,
    limit = 25,
  } = options;

  const rosterTarget = rosterFilter ? normalizeName(rosterFilter) : null;
  const accounts = rosterTarget
    ? userDoc.accounts.filter(
        (a) => normalizeName(a.accountName) === rosterTarget
      )
    : userDoc.accounts;

  const target = normalizeName(needle);
  const entries = [];
  const seen = new Set();
  for (const account of accounts) {
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      const name = getCharName(character);
      if (!name) continue;
      const normalized = normalizeName(name);
      if (dedup && seen.has(normalized)) continue;
      if (target && !normalized.includes(target)) continue;
      if (dedup) seen.add(normalized);
      const sideTasks = Array.isArray(character.sideTasks)
        ? character.sideTasks
        : [];
      entries.push({
        character,
        account,
        name,
        className: getCharClass(character),
        itemLevel: Number(character.itemLevel) || 0,
        sideTaskCount: sideTasks.length,
      });
    }
  }

  if (sortByILvl) {
    entries.sort(
      (a, b) => b.itemLevel - a.itemLevel || a.name.localeCompare(b.name)
    );
  }
  return entries.slice(0, limit);
}

/**
 * Format a Discord autocomplete choice with the 100-char name + value
 * caps applied. Use this at the end of every autocomplete pipeline so
 * callers don't repeat the truncation math.
 */
function truncateChoice(label, value, max = 100) {
  const safeLabel = String(label || "");
  const safeValue = String(value || "");
  return {
    name:
      safeLabel.length > max ? `${safeLabel.slice(0, max - 3)}...` : safeLabel,
    value: safeValue.length > max ? safeValue.slice(0, max) : safeValue,
  };
}

module.exports = {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
};
