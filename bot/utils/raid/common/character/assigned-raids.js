"use strict";

const {
  normalizeName,
  toModeKey,
  toModeLabel,
} = require("../shared");
const {
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
} = require("../../../../models/Raid");

const RAID_REQUIREMENT_MAP = getRaidRequirementMap();
const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

function getRequirementFor(raidKey, modeKey) {
  const value = `${raidKey}_${modeKey}`;
  return RAID_REQUIREMENT_MAP[value] || null;
}

function getBestEligibleModeKey(raidKey, itemLevel) {
  const modes = Object.entries(RAID_REQUIREMENTS[raidKey]?.modes || {})
    .map(([modeKey, mode]) => ({ modeKey, minItemLevel: Number(mode.minItemLevel) || 0 }))
    .filter(({ modeKey }) => RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey]?.manualOnly !== true)
    .filter((item) => Number(itemLevel) >= item.minItemLevel)
    .sort((a, b) => b.minItemLevel - a.minItemLevel);

  return modes[0]?.modeKey || null;
}

function normalizeRaidModeKey(raidKey, modeKey) {
  const key = normalizeName(modeKey);
  if (!key) return null;
  return getRequirementFor(raidKey, key) ? key : null;
}

function toPlainAssignedRaid(assignedRaid) {
  return assignedRaid && typeof assignedRaid.toObject === "function"
    ? assignedRaid.toObject()
    : { ...(assignedRaid || {}) };
}

function setAssignedRaidMode(assignedRaid, raidKey, modeKey, { completedDate = null } = {}) {
  const normalizedModeKey = normalizeRaidModeKey(raidKey, modeKey);
  const plain = toPlainAssignedRaid(assignedRaid);
  if (!normalizedModeKey) return plain;

  plain.modeKey = normalizedModeKey;
  delete plain.pendingModeKey;
  const label = toModeLabel(normalizedModeKey);
  for (const gate of getGatesForRaid(raidKey)) {
    plain[gate] = { difficulty: label, completedDate };
  }
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

  let canonicalModeKey = null;
  let canonicalDifficulty = null;
  if (diffTally.size === 0) {
    ({ canonicalDifficulty, canonicalModeKey } = resolveEmptyCompletionDifficulty({
      assignedRaid,
      fallbackDifficulty,
      raidKey,
    }));
  } else {
    canonicalDifficulty = pickCanonicalDifficultyFromCompletions(diffTally);
    canonicalModeKey = normalizeRaidModeKey(raidKey, toModeKey(canonicalDifficulty)) || null;
  }

  const canonicalNorm = normalizeName(canonicalDifficulty);
  const normalized = canonicalModeKey ? { modeKey: canonicalModeKey } : {};
  if (assignedRaid?.goldOverride === "include" || assignedRaid?.goldForced === true) {
    normalized.goldOverride = "include";
  } else if (assignedRaid?.goldOverride === "exclude" || assignedRaid?.goldDisabled === true) {
    normalized.goldOverride = "exclude";
  }
  const pendingModeKey = normalizeRaidModeKey(raidKey, assignedRaid?.pendingModeKey);
  if (pendingModeKey) normalized.pendingModeKey = pendingModeKey;
  for (const gate of keys) {
    const source = assignedRaid?.[gate] || {};
    const sourceDiff = source.difficulty;
    const sourceMatchesCanonical =
      !sourceDiff || normalizeName(sourceDiff) === canonicalNorm;
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

function ensureAssignedRaids(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const existing = character?.assignedRaids || {};
  const legacyRaids = Array.isArray(character?.raids) ? character.raids : [];
  const assigned = {};

  for (const raidKey of RAID_GROUP_KEYS) {
    const bestModeKey = getBestEligibleModeKey(raidKey, itemLevel) || "normal";
    const fallbackDifficulty = toModeLabel(bestModeKey);
    const sourceRaid = existing[raidKey] || {};

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
  RAID_GROUP_KEYS,
  RAID_REQUIREMENT_MAP,
  buildAssignedRaidFromLegacy,
  ensureAssignedRaids,
  getAssignedRaidCompletedAt,
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
  getCompletedGateKeys,
  getGateKeys,
  getRequirementFor,
  isAssignedRaidCompleted,
  normalizeAssignedRaid,
  normalizeRaidModeKey,
  pickCanonicalDifficultyFromCompletions,
  resolveEmptyCompletionDifficulty,
  setAssignedRaidMode,
  tallyCompletedDifficulties,
  toPlainAssignedRaid,
};
