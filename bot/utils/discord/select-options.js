"use strict";

/**
 * Return at most `limit` entries while keeping the active entry visible.
 * Discord select menus cap options, so an active item outside the first page
 * replaces the last visible item instead of disappearing from the control.
 */
function selectEntriesWithPinnedActive(
  entries,
  {
    limit = 25,
    activeValue = null,
    getValue = (entry) => entry,
  } = {}
) {
  const source = Array.isArray(entries) ? entries : [];
  const normalizedLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  const visible = source.slice(0, normalizedLimit);
  const hasActiveValue =
    activeValue !== null && activeValue !== undefined && activeValue !== "";

  if (!hasActiveValue || visible.length === 0) return visible;

  const matchesActive = (entry) => getValue(entry) === activeValue;
  if (visible.some(matchesActive)) return visible;

  const activeEntry = source.find(matchesActive);
  if (activeEntry) visible[visible.length - 1] = activeEntry;
  return visible;
}

/**
 * Filter in source order and stop once Discord's result page is full.
 * @param {object[]} choices Candidate name/value pairs.
 * @param {object} [options] Needle, pure normalizer, and result limit.
 * @returns {object[]} Matching choices, capped to the normalized limit.
 */
function filterAutocompleteChoices(
  choices,
  {
    needle = "",
    normalize = (value) => String(value || "").trim().toLowerCase(),
    limit = 25,
  } = {}
) {
  const source = Array.isArray(choices) ? choices : [];
  const normalizedNeedle = normalize(needle || "");
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!normalizedNeedle) return source.slice(0, max);
  const matches = [];
  for (let index = 0; index < source.length && matches.length < max; index += 1) {
    if (!(index in source)) continue; // Match Array.filter's sparse-array behavior.
    const choice = source[index];
    if (normalize(choice?.name).includes(normalizedNeedle) ||
        normalize(choice?.value).includes(normalizedNeedle)) matches.push(choice);
  }
  return matches;
}

module.exports = {
  filterAutocompleteChoices,
  selectEntriesWithPinnedActive,
};
