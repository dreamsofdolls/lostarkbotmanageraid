"use strict";

const {
  normalizeName,
  toModeKey,
  toModeLabel,
} = require("../shared");
const {
  RAID_ORDER,
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
  isSelectableMode,
} = require("../../../../domain/raid-catalog");
const { getGoldOverride } = require("./gold-policy");

const RAID_REQUIREMENT_MAP = getRaidRequirementMap();

function getRequirementFor(raidKey, modeKey) {
  const value = `${raidKey}_${modeKey}`;
  return RAID_REQUIREMENT_MAP[value] || null;
}

// Modes the automatic default may pick (not manual-only, and not retired unless
// asked), hardest first.
function getAutoModes(raidKey, { includeRetired = false } = {}) {
  return Object.entries(RAID_REQUIREMENTS[raidKey]?.modes || {})
    .filter(([modeKey, mode]) => mode.manualOnly !== true
      && (includeRetired || isSelectableMode(raidKey, modeKey)))
    .map(([modeKey, mode]) => ({ modeKey, minItemLevel: Number(mode.minItemLevel) || 0 }))
    .sort((a, b) => b.minItemLevel - a.minItemLevel);
}

/**
 * Hardest automatic mode the item level allows. Manual-only modes never count;
 * retired modes count only with `includeRetired`.
 * @param {string} raidKey - catalog raid key
 * @param {number} itemLevel - character item level
 * @param {{includeRetired?: boolean}} [options]
 * @returns {string|null} null when no automatic mode is eligible
 */
function getBestEligibleModeKey(raidKey, itemLevel, options) {
  return getAutoModes(raidKey, options)
    .find((item) => Number(itemLevel) >= item.minItemLevel)?.modeKey || null;
}

/**
 * Mode a raid falls back to when nothing is stored: the hardest automatic mode
 * the item level allows, else the easiest automatic mode, which the status
 * item-level check then hides (Horizon below 1750).
 * @param {string} raidKey - catalog raid key
 * @param {number} itemLevel - character item level
 * @returns {string|null} null only for a raid key outside the catalog
 */
function getDefaultModeKey(raidKey, itemLevel) {
  const modes = getAutoModes(raidKey);
  return getBestEligibleModeKey(raidKey, itemLevel) || modes[modes.length - 1]?.modeKey || null;
}

function normalizeRaidModeKey(raidKey, modeKey) {
  const key = normalizeName(modeKey);
  if (!key) return null;
  return getRequirementFor(raidKey, key) ? key : null;
}

function getUnsupportedSoloFallbackModeKey(raidKey, modeKey) {
  const key = toModeKey(modeKey);
  if (key !== "solo" || getRequirementFor(raidKey, "solo")) return null;
  return getRequirementFor(raidKey, "normal") ? "normal" : null;
}

function toPlainAssignedRaid(assignedRaid) {
  return assignedRaid && typeof assignedRaid.toObject === "function"
    ? assignedRaid.toObject()
    : { ...(assignedRaid || {}) };
}

/**
 * Detect a stored mode or official-gate difficulty conflict without mutating it.
 * The injected normalizer must be pure; matching stops at the first conflict.
 */
function hasAssignedRaidModeChange(assignedRaid, modeKey, difficulty, gates, normalize = normalizeName) {
  if (assignedRaid.modeKey && assignedRaid.modeKey !== modeKey) return true;
  const selected = normalize(difficulty);
  return gates.some((gate) => {
    const existing = assignedRaid[gate]?.difficulty;
    return Boolean(existing && normalize(existing) !== selected);
  });
}

/** Overwrite only the supplied gates, preserving mode choices and other raid metadata. */
function resetAssignedRaidGates(assignedRaid, gates, difficulty, completedDate) {
  for (const gate of gates) {
    assignedRaid[gate] = { difficulty, completedDate };
  }
}

function setAssignedRaidMode(assignedRaid, raidKey, modeKey, { completedDate = null } = {}) {
  const normalizedModeKey = normalizeRaidModeKey(raidKey, modeKey);
  const plain = toPlainAssignedRaid(assignedRaid);
  if (!normalizedModeKey) return plain;

  plain.modeKey = normalizedModeKey;
  delete plain.pendingModeKey;
  const label = toModeLabel(normalizedModeKey);
  resetAssignedRaidGates(plain, getGatesForRaid(raidKey), label, completedDate);
  return plain;
}

function getAssignedRaidModeKey(assignedRaid, raidKey) {
  return normalizeRaidModeKey(raidKey, assignedRaid?.modeKey);
}

function getGateKeys(assignedRaid) {
  return Object.keys(assignedRaid || {})
    .filter((key) => /^G\d+$/i.test(key))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function pickCanonicalDifficultyFromCompletions(diffTally) {
  let best = null;
  for (const entry of diffTally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.raw;
}

function resolveEmptyCompletionDifficulty({ assignedRaid, fallbackDifficulty, raidKey }) {
  const storedModeKey = getAssignedRaidModeKey(assignedRaid, raidKey);
  const existingDifficulty = assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty;
  if (storedModeKey) {
    return {
      canonicalDifficulty: toModeLabel(storedModeKey),
      canonicalModeKey: storedModeKey,
    };
  }
  const unsupportedSoloFallback = getUnsupportedSoloFallbackModeKey(
    raidKey,
    assignedRaid?.modeKey || existingDifficulty
  );
  if (unsupportedSoloFallback) {
    return {
      canonicalDifficulty: toModeLabel(unsupportedSoloFallback),
      canonicalModeKey: unsupportedSoloFallback,
    };
  }
  if (!existingDifficulty) {
    return {
      canonicalDifficulty: fallbackDifficulty,
      canonicalModeKey: null,
    };
  }

  const existingMin =
    getRequirementFor(raidKey, toModeKey(existingDifficulty))?.minItemLevel || 0;
  const fallbackMin =
    getRequirementFor(raidKey, toModeKey(fallbackDifficulty))?.minItemLevel || 0;
  return {
    canonicalDifficulty: fallbackMin > existingMin ? fallbackDifficulty : existingDifficulty,
    canonicalModeKey: null,
  };
}

function tallyCompletedDifficulties(assignedRaid, gateKeys) {
  const diffTally = new Map();
  for (const gate of gateKeys) {
    const source = assignedRaid?.[gate];
    if (!source?.difficulty) continue;
    if (!(Number(source.completedDate) > 0)) continue;
    const key = normalizeName(source.difficulty);
    const entry = diffTally.get(key) || { count: 0, raw: source.difficulty };
    entry.count += 1;
    diffTally.set(key, entry);
  }
  return diffTally;
}

function normalizeAssignedRaid(assignedRaid, fallbackDifficulty, raidKey) {
  const officialGates = getGatesForRaid(raidKey);
  const rawGateKeys = getGateKeys(assignedRaid).filter((k) => officialGates.includes(k));
  const keys = rawGateKeys.length > 0 ? rawGateKeys : officialGates;
  const diffTally = tallyCompletedDifficulties(assignedRaid, keys);

  let canonicalModeKey;
  let canonicalDifficulty;
  if (diffTally.size === 0) {
    ({ canonicalDifficulty, canonicalModeKey } = resolveEmptyCompletionDifficulty({
      assignedRaid,
      fallbackDifficulty,
      raidKey,
    }));
  } else {
    canonicalDifficulty = pickCanonicalDifficultyFromCompletions(diffTally);
    canonicalModeKey = normalizeRaidModeKey(raidKey, toModeKey(canonicalDifficulty))
      || getUnsupportedSoloFallbackModeKey(raidKey, canonicalDifficulty)
      || null;
    if (canonicalModeKey) canonicalDifficulty = toModeLabel(canonicalModeKey);
  }

  const canonicalNorm = normalizeName(canonicalDifficulty);
  const normalized = canonicalModeKey ? { modeKey: canonicalModeKey } : {};
  const goldOverride = getGoldOverride(assignedRaid);
  if (goldOverride) normalized.goldOverride = goldOverride;
  const pendingModeKey = normalizeRaidModeKey(raidKey, assignedRaid?.pendingModeKey);
  if (pendingModeKey) normalized.pendingModeKey = pendingModeKey;
  for (const gate of keys) {
    const source = assignedRaid?.[gate] || {};
    const sourceDiff = source.difficulty;
    const sourceFallbackModeKey = getUnsupportedSoloFallbackModeKey(raidKey, sourceDiff);
    const sourceMatchesCanonical =
      !sourceDiff ||
      normalizeName(sourceDiff) === canonicalNorm ||
      sourceFallbackModeKey === canonicalModeKey;
    normalized[gate] = {
      difficulty: canonicalDifficulty,
      completedDate: sourceMatchesCanonical ? (Number(source.completedDate) || undefined) : undefined,
    };
  }

  return normalized;
}

function getCompletedGateKeys(assignedRaid) {
  return getGateKeys(assignedRaid).filter((gate) => Number(assignedRaid?.[gate]?.completedDate) > 0);
}

function buildAssignedRaidFromLegacy(legacyRaid) {
  const requirement = getRaidRequirementList().find(
    (raid) => normalizeName(raid.label) === normalizeName(legacyRaid?.raidName)
  );
  if (!requirement) return null;

  const modeLabel = toModeLabel(requirement.modeKey);
  const completedDate = legacyRaid?.isCompleted ? Date.now() : undefined;
  const data = { modeKey: requirement.modeKey };
  for (const gate of getGatesForRaid(requirement.raidKey)) {
    data[gate] = { difficulty: modeLabel, completedDate };
  }
  return { raidKey: requirement.raidKey, data };
}

/**
 * Every catalog raid of a character, normalized. A raid with no stored mode and
 * no clears takes the default mode; one ticked for gold by hand keeps the mode
 * it was ticked on, retired modes included.
 * @param {object} character - character document or plain object
 * @returns {Object<string, object>} assigned raids keyed by raid key
 */
function ensureAssignedRaids(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const existing = character?.assignedRaids || {};
  const legacyRaids = Array.isArray(character?.raids) ? character.raids : [];
  const assigned = {};

  for (const raidKey of RAID_ORDER) {
    const sourceRaid = existing[raidKey] || {};
    const tickedForGold = getGoldOverride(sourceRaid) === "include";
    const fallbackModeKey = (tickedForGold && getBestEligibleModeKey(raidKey, itemLevel, { includeRetired: true }))
      || getDefaultModeKey(raidKey, itemLevel);
    const fallbackDifficulty = toModeLabel(fallbackModeKey);

    assigned[raidKey] = normalizeAssignedRaid(sourceRaid, fallbackDifficulty, raidKey);
  }

  for (const legacyRaid of legacyRaids) {
    const converted = buildAssignedRaidFromLegacy(legacyRaid);
    if (!converted) continue;
    assigned[converted.raidKey] = converted.data;
  }

  return assigned;
}

function isAssignedRaidCompleted(assignedRaid) {
  const gates = getGateKeys(assignedRaid);
  if (gates.length === 0) return false;
  return gates.every((gate) => Number(assignedRaid?.[gate]?.completedDate) > 0);
}

function getAssignedRaidCompletedAt(assignedRaid, gates = null) {
  const gateKeys = Array.isArray(gates) && gates.length > 0
    ? gates
    : getGateKeys(assignedRaid);
  if (gateKeys.length === 0) return null;

  let latest = 0;
  for (const gate of gateKeys) {
    const ts = Number(assignedRaid?.[gate]?.completedDate) || 0;
    if (ts <= 0) return null;
    if (ts > latest) latest = ts;
  }
  return latest > 0 ? latest : null;
}

module.exports = {
  RAID_REQUIREMENT_MAP,
  ensureAssignedRaids,
  getAssignedRaidCompletedAt,
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
  getCompletedGateKeys,
  getDefaultModeKey,
  getGateKeys,
  getRequirementFor,
  hasAssignedRaidModeChange,
  isAssignedRaidCompleted,
  normalizeAssignedRaid,
  normalizeRaidModeKey,
  resetAssignedRaidGates,
  setAssignedRaidMode,
  toPlainAssignedRaid,
};
