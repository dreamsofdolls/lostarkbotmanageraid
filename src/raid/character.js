/**
 * character.js
 *
 * Pure character + raid normalization helpers extracted from raid-command.js.
 * No closure on Discord client / Mongoose models / scheduler state. Every
 * function takes its inputs explicitly and returns plain values, which makes
 * them trivially unit-testable in isolation.
 *
 * Used by: raid-command.js (compose root), commands/raid-status.js,
 * commands/raid-check.js, services/auto-manage-core.js (indirectly via
 * raid-command's __test exports).
 */

const { randomUUID } = require("node:crypto");
const {
  UI,
  normalizeName,
  foldName,
  toModeLabel,
  toModeKey,
  getCharacterName,
  getCharacterClass,
} = require("./shared");
const {
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
} = require("../data/Raid");

const RAID_REQUIREMENT_MAP = getRaidRequirementMap();
const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

function createCharacterId() {
  try {
    return randomUUID();
  } catch {
    return `char_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function buildFetchedRosterIndexes(fetchedChars) {
  const byName = new Map();
  const byFoldedName = new Map();

  for (const fetched of fetchedChars || []) {
    const charName = fetched?.charName;
    const normalized = normalizeName(charName);
    if (!normalized) continue;

    byName.set(normalized, fetched);

    const folded = foldName(charName);
    if (!folded) continue;
    if (!byFoldedName.has(folded)) byFoldedName.set(folded, []);
    byFoldedName.get(folded).push(fetched);
  }

  return { byName, byFoldedName };
}

function pickUniqueFetchedRosterCandidate(candidates, character) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const storedClass = normalizeName(getCharacterClass(character));
  const classMatches = storedClass
    ? candidates.filter((c) => normalizeName(c?.className) === storedClass)
    : [];
  if (classMatches.length === 1) return classMatches[0];

  const narrowed = classMatches.length > 0 ? classMatches : candidates;
  const storedItemLevel = Number(character?.itemLevel) || 0;
  if (storedItemLevel > 0) {
    const closeMatches = narrowed.filter((c) => {
      const fetchedItemLevel = Number(c?.itemLevel) || 0;
      return fetchedItemLevel > 0 && Math.abs(fetchedItemLevel - storedItemLevel) < 2;
    });
    if (closeMatches.length === 1) return closeMatches[0];
  }

  return null;
}

function findFetchedRosterMatchForCharacter(character, indexes) {
  const currentName = getCharacterName(character);
  const exact = indexes?.byName?.get(normalizeName(currentName));
  if (exact) return { match: exact, matchType: "exact" };

  const folded = foldName(currentName);
  if (!folded) return null;

  const foldedCandidates = indexes?.byFoldedName?.get(folded) || [];
  const foldedMatch = pickUniqueFetchedRosterCandidate(foldedCandidates, character);
  if (!foldedMatch) return null;

  return { match: foldedMatch, matchType: "folded" };
}

function getRequirementFor(raidKey, modeKey) {
  const value = `${raidKey}_${modeKey}`;
  return RAID_REQUIREMENT_MAP[value] || null;
}

function getBestEligibleModeKey(raidKey, itemLevel) {
  const modes = Object.entries(RAID_REQUIREMENTS[raidKey]?.modes || {})
    .map(([modeKey, mode]) => ({ modeKey, minItemLevel: Number(mode.minItemLevel) || 0 }))
    .filter((item) => Number(itemLevel) >= item.minItemLevel)
    .sort((a, b) => b.minItemLevel - a.minItemLevel);

  return modes[0]?.modeKey || null;
}

function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task && task.id)
    .map((task) => ({
      id: String(task.id),
      completions: Number(task.completions) || 0,
      completionDate: Number(task.completionDate) || undefined,
    }));
}

// Sanitize per-character side-task entries (sideTaskSchema in models/user.js).
// Mirrors sanitizeTasks but maps the sideTaskSchema fields. Treated as
// user-owned state on par with `tasks`, so buildCharacterRecord must
// preserve it across roster rebuilds (e.g. /edit-roster Confirm) — without
// this pass, a Confirm that keeps a char would silently wipe its side
// tasks because the helper rebuilds the char shape from a minimal field
// list.
function sanitizeSideTasks(sideTasks) {
  if (!Array.isArray(sideTasks)) return [];
  return sideTasks
    .filter((task) => task && task.taskId && task.name)
    .map((task) => ({
      taskId: String(task.taskId),
      name: String(task.name),
      reset: task.reset === "weekly" ? "weekly" : "daily",
      completed: Boolean(task.completed),
      lastResetAt: Number(task.lastResetAt) || 0,
      createdAt: Number(task.createdAt) || Date.now(),
    }));
}

function getGateKeys(assignedRaid) {
  return Object.keys(assignedRaid || {})
    .filter((key) => /^G\d+$/i.test(key))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function normalizeAssignedRaid(assignedRaid, fallbackDifficulty, raidKey) {
  // Drop any gate keys that are not part of the raid's current official
  // gate list (e.g. legacy Serca G3 stored before the metadata correction).
  // This ensures status counts match reality and lets DB self-heal on next
  // save, since callers reassign `character.assignedRaids = <normalized>`.
  const officialGates = getGatesForRaid(raidKey);
  const rawGateKeys = getGateKeys(assignedRaid).filter((k) => officialGates.includes(k));
  const keys = rawGateKeys.length > 0 ? rawGateKeys : officialGates;

  // Self-heal legacy mixed-mode records (e.g. G1=Nightmare + G2=Hard created
  // before the write-path mode-coherence fix). Pick one canonical difficulty
  // so downstream reads - /raid-status, /raid-set autocomplete - all agree
  // on the raid's mode and count completions correctly.
  //
  // Rule: prefer the difficulty that carries the most `completedDate > 0`
  // gates (conservation of progress), then G1's stored difficulty, then the
  // caller's fallback. Non-canonical completions are dropped because Lost
  // Ark weekly entries are mode-scoped - progress on a "minority" mode is
  // a corrupted claim from the old process bug.
  const diffTally = new Map();
  for (const gate of keys) {
    const source = assignedRaid?.[gate];
    if (!source?.difficulty) continue;
    if (!(Number(source.completedDate) > 0)) continue;
    const key = normalizeName(source.difficulty);
    const entry = diffTally.get(key) || { count: 0, raw: source.difficulty };
    entry.count += 1;
    diffTally.set(key, entry);
  }

  let canonicalDifficulty;
  if (diffTally.size === 0) {
    canonicalDifficulty =
      assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || fallbackDifficulty;
  } else {
    let best = null;
    for (const entry of diffTally.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    canonicalDifficulty = best.raw;
  }
  const canonicalNorm = normalizeName(canonicalDifficulty);

  const normalized = {};
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
  const data = {};
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

function buildCharacterRecord(source, fallbackId) {
  return {
    id: String(source?.id || fallbackId || createCharacterId()),
    name: getCharacterName(source),
    class: getCharacterClass(source),
    itemLevel: Number(source?.itemLevel) || 0,
    isGoldEarner: Boolean(source?.isGoldEarner),
    combatScore: String(source?.combatScore || ""),
    assignedRaids: ensureAssignedRaids(source),
    tasks: sanitizeTasks(source?.tasks),
    sideTasks: sanitizeSideTasks(source?.sideTasks),
  };
}



function ensureRaidEntries(character) {
  const assignedRaids = ensureAssignedRaids(character);
  const raids = [];

  for (const raidKey of RAID_GROUP_KEYS) {
    const assignedRaid = assignedRaids[raidKey];
    const difficulty = assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal";
    const modeKey = toModeKey(difficulty);
    const requirement = getRequirementFor(raidKey, modeKey) || getRequirementFor(raidKey, "normal");
    if (!requirement) continue;

    raids.push({
      raidName: requirement.label,
      raidKey,
      modeKey,
      minItemLevel: requirement.minItemLevel,
      completedGateKeys: getCompletedGateKeys(assignedRaid),
      isCompleted: isAssignedRaidCompleted(assignedRaid),
    });
  }

  return raids;
}

function getStatusRaidsForCharacter(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const assignedRaids = ensureAssignedRaids(character);
  const selected = [];

  for (const raidKey of RAID_GROUP_KEYS) {
    const assignedRaid = assignedRaids[raidKey];
    const selectedDifficulty = assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal";
    const modeKey = toModeKey(selectedDifficulty);
    const completedGateKeys = getCompletedGateKeys(assignedRaid);

    // At 1740+, surface both Serca Hard and Nightmare as selectable options
    // (Hard alone still eligible from 1730 via the generic branch below).
    const rawGateKeys = getGateKeys(assignedRaid);
    const allGateKeys = rawGateKeys.length > 0 ? rawGateKeys : getGatesForRaid(raidKey);

    if (raidKey === "serca" && itemLevel >= 1740) {
      // Lockout-aware: in Lost Ark the weekly raid slot is shared across
      // every difficulty of the same raid, so clearing at any one mode
      // (Normal/Hard/Nightmare) consumes the slot. Once the char has any
      // completed gate this week, only surface the actually-cleared mode -
      // showing a "0/2 pending Nightmare" card next to "2/2 Hard done"
      // is misleading because the char physically can't run Nightmare
      // until next reset. normalizeAssignedRaid above already promoted
      // canonicalDifficulty to the cleared mode, so modeKey here points
      // at the right card.
      const lockedThisWeek = completedGateKeys.length > 0;
      if (lockedThisWeek) {
        const requirement = getRequirementFor(raidKey, modeKey);
        if (requirement && itemLevel >= requirement.minItemLevel) {
          selected.push({
            raidName: requirement.label,
            raidKey,
            modeKey,
            minItemLevel: requirement.minItemLevel,
            allGateKeys,
            completedGateKeys,
            isCompleted: isAssignedRaidCompleted(assignedRaid),
          });
        }
        continue;
      }

      // Not locked yet - surface BOTH Hard and Nightmare so the leader
      // can see which mode the char is set up for.
      for (const sercaModeKey of ["hard", "nightmare"]) {
        const sercaRequirement = getRequirementFor(raidKey, sercaModeKey);
        if (!sercaRequirement || itemLevel < sercaRequirement.minItemLevel) continue;

        const isSameMode = modeKey === sercaModeKey;
        selected.push({
          raidName: sercaRequirement.label,
          raidKey,
          modeKey: sercaModeKey,
          minItemLevel: sercaRequirement.minItemLevel,
          allGateKeys,
          completedGateKeys: isSameMode ? completedGateKeys : [],
          isCompleted: isSameMode && isAssignedRaidCompleted(assignedRaid),
        });
      }
      continue;
    }

    const requirement = getRequirementFor(raidKey, modeKey);
    if (!requirement || itemLevel < requirement.minItemLevel) continue;

    selected.push({
      raidName: requirement.label,
      raidKey,
      modeKey,
      minItemLevel: requirement.minItemLevel,
      allGateKeys,
      completedGateKeys,
      isCompleted: isAssignedRaidCompleted(assignedRaid),
    });
  }

  // Display order: Act 4 → Kazeros (Final) → Serca, top-to-bottom per
  // character card. Within the same raid (Serca Hard vs Nightmare at 1740+),
  // the lower difficulty tier comes first because it is the lower iLvl gate -
  // e.g. Serca Hard (1730) appears above Serca Nightmare (1740).
  const raidDisplayOrder = { armoche: 0, kazeros: 1, serca: 2 };
  return selected.sort((a, b) => {
    const orderDiff = (raidDisplayOrder[a.raidKey] ?? 99) - (raidDisplayOrder[b.raidKey] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    return (Number(a.minItemLevel) || 0) - (Number(b.minItemLevel) || 0);
  });
}

// 3-state aggregate icon for a (done, total) pair. Shared by /raid-status's
// per-raid line AND /raid-check's per-char card so both commands surface the
// same visual vocabulary: 🟢 = all done, 🟡 = at least 1 done but not all,
// ⚪ = none done. `total=0` guards divide-by-zero for chars with no eligible
// gates (lock icon handled upstream).
function pickProgressIcon(done, total) {
  if (total > 0 && done === total) return UI.icons.done;
  if (done > 0) return UI.icons.partial;
  return UI.icons.pending;
}

function formatRaidStatusLine(raid) {
  const gates = Array.isArray(raid.allGateKeys) && raid.allGateKeys.length > 0
    ? raid.allGateKeys
    : getGatesForRaid(raid.raidKey);
  const done = new Set(raid.completedGateKeys || []).size;
  const total = gates.length;
  const icon = raid.isCompleted ? UI.icons.done : pickProgressIcon(done, total);
  return `${icon} ${raid.raidName} · ${done}/${total}`;
}

function summarizeRaidProgress(allRaids) {
  const total = allRaids.length;
  if (total === 0) return { color: UI.colors.muted, completed: 0, partial: 0, total: 0 };

  let completed = 0;
  let partial = 0;
  for (const raid of allRaids) {
    if (raid.isCompleted) completed += 1;
    else if ((raid.completedGateKeys || []).length > 0) partial += 1;
  }

  let color = UI.colors.neutral;
  if (completed === total) color = UI.colors.success;
  else if (completed > 0 || partial > 0) color = UI.colors.progress;

  return { color, completed, partial, total };
}

// Per-gate display icon for Phase 1 progress-aware /raid-check rendering.
// 'done'    = gate completed AT this raid's selected difficulty
// 'partial' = unused right now (kept for future per-gate "started" semantics)
// 'pending' = gate not done OR done at a different difficulty (mode-switch
//             would wipe it anyway, so it's not real progress for this scan)
function raidCheckGateIcon(status) {
  if (status === "done") return "🟢";
  if (status === "partial") return "🟡";
  return "⚪";
}

module.exports = {
  createCharacterId,
  buildFetchedRosterIndexes,
  pickUniqueFetchedRosterCandidate,
  findFetchedRosterMatchForCharacter,
  getRequirementFor,
  getBestEligibleModeKey,
  sanitizeTasks,
  sanitizeSideTasks,
  getGateKeys,
  normalizeAssignedRaid,
  getCompletedGateKeys,
  buildAssignedRaidFromLegacy,
  ensureAssignedRaids,
  isAssignedRaidCompleted,
  buildCharacterRecord,
  ensureRaidEntries,
  getStatusRaidsForCharacter,
  pickProgressIcon,
  formatRaidStatusLine,
  summarizeRaidProgress,
  raidCheckGateIcon,
  RAID_REQUIREMENT_MAP,
};
