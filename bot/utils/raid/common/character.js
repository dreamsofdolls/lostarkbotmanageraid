/**
 * character.js
 *
 * Pure character + raid normalization helpers extracted from bot/commands.js.
 * No closure on Discord client / Mongoose models / scheduler state. Every
 * function takes its inputs explicitly and returns plain values, which makes
 * them trivially unit-testable in isolation.
 *
 * Used by: bot/commands.js (compose root), handlers/raid-status.js,
 * handlers/raid-check.js, services/auto-manage/runtime/core.js (indirectly via
 * commands.__test exports).
 */

const { randomUUID } = require("node:crypto");
const {
  UI,
  toModeKey,
  getCharacterName,
  getCharacterClass,
} = require("./shared");
const {
  getGatesForRaid,
  getGoldForGate,
  isGoldBound,
} = require("../../../models/Raid");
const {
  RAID_GROUP_KEYS,
  RAID_REQUIREMENT_MAP,
  buildAssignedRaidFromLegacy,
  ensureAssignedRaids,
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
  getCompletedGateKeys,
  getGateKeys,
  getRequirementFor,
  isAssignedRaidCompleted,
  normalizeAssignedRaid,
} = require("./character/assigned-raids");
const {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  pickUniqueFetchedRosterCandidate,
} = require("./character/roster-matching");
const {
  sanitizeSideTasks,
  sanitizeTasks,
} = require("./character/task-sanitizers");

function createCharacterId() {
  try {
    return randomUUID();
  } catch {
    return `char_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function buildCharacterRecord(source, fallbackId) {
  return {
    id: String(source?.id || fallbackId || createCharacterId()),
    name: getCharacterName(source),
    class: getCharacterClass(source),
    itemLevel: Number(source?.itemLevel) || 0,
    // Default true on missing field: matches the schema default. A
    // freshly-built record from /raid-add-roster (where source has no
    // isGoldEarner key) opts in by default; an explicit `false` (set via
    // /raid-gold-earner) is preserved verbatim. Without the `!== false`
    // guard, `Boolean(undefined)` would silently downgrade every new
    // char to non-earner - the bug the previous default-false world had.
    isGoldEarner: source?.isGoldEarner !== false,
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
    const modeKey = getAssignedRaidModeKey(assignedRaid, raidKey)
      || toModeKey(assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal");
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

// Compute the (earnedGold, totalGold) pair for a raid entry. earnedGold
// sums the gold reward of every gate already cleared this week at the
// raid's selected mode; totalGold sums every official gate of that mode.
// Both values are raid-intrinsic - they do NOT account for the
// character's `isGoldEarner` flag, since LA's 6-gold-earner cap is a
// per-roster constraint applied by the rollup layer (see
// summarizeAccountGold).
function computeRaidGold(raidKey, modeKey, completedGateKeys, allGateKeys) {
  let earned = 0;
  for (const gate of completedGateKeys || []) {
    earned += getGoldForGate(raidKey, modeKey, gate);
  }
  let total = 0;
  for (const gate of allGateKeys || []) {
    total += getGoldForGate(raidKey, modeKey, gate);
  }
  // goldBound tags the whole entry: a mode's gold is wholly bound or unbound,
  // so the rollup can bucket earned/total without re-querying the catalog.
  return { earnedGold: earned, totalGold: total, goldBound: isGoldBound(raidKey, modeKey) };
}

function getStatusRaidsForCharacter(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const assignedRaids = ensureAssignedRaids(character);
  const selected = [];

  for (const raidKey of RAID_GROUP_KEYS) {
    const assignedRaid = assignedRaids[raidKey];
    const modeKey = getAssignedRaidModeKey(assignedRaid, raidKey)
      || toModeKey(assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal");
    const completedGateKeys = getCompletedGateKeys(assignedRaid);

    const rawGateKeys = getGateKeys(assignedRaid);
    const allGateKeys = rawGateKeys.length > 0 ? rawGateKeys : getGatesForRaid(raidKey);

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
      ...computeRaidGold(raidKey, modeKey, completedGateKeys, allGateKeys),
    });
  }

  // Display order: Act 4 → Kazeros (Final) → Serca, top-to-bottom per
  // character card. Each raid contributes at most one mode; Serca follows
  // the same lockout model as Kazeros: default to the best eligible mode,
  // then show the mode actually cleared when the player runs a lower tier.
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

function formatRaidStatusLine(raid, lang) {
  const gates = Array.isArray(raid.allGateKeys) && raid.allGateKeys.length > 0
    ? raid.allGateKeys
    : getGatesForRaid(raid.raidKey);
  const done = new Set(raid.completedGateKeys || []).size;
  const total = gates.length;
  const icon = raid.isCompleted ? UI.icons.done : pickProgressIcon(done, total);
  // Lang-aware label: pull from locale registry when a lang is supplied,
  // otherwise fall back to the raid's canonical raidName for back-compat
  // (older callers haven't been migrated yet, and tests use the older
  // signature).
  let label = raid.raidName;
  if (lang) {
    // Lazy-require to avoid circular import: labels.js → models/Raid.js
    // → (potentially) other utils. Pull at call time so the dependency
    // graph stays clean at module load.
    const { getRaidModeLabel } = require("./labels");
    label = getRaidModeLabel(raid.raidKey, raid.modeKey, lang) || raid.raidName;
  }
  return `${icon} ${label} · ${done}/${total}`;
}

// Sum (earned, total) gold across an array of raid entries already
// scoped to one character. Caller decides whether to apply the
// `isGoldEarner` gate - this helper only does the arithmetic so it
// composes with the per-char card path (which always renders, gated by
// `isGoldEarner` at the view layer to swap in the muted "Not gold-earner"
// line).
// Returns the grand totals (earned/total, unchanged shape for back-compat) plus
// a bound/unbound breakdown so callers can show how much of the gold is
// roster-bound. earned === earnedBound + earnedUnbound (same for total).
function summarizeCharacterGold(raids) {
  let earned = 0;
  let total = 0;
  let earnedBound = 0;
  let totalBound = 0;
  for (const raid of raids || []) {
    const e = Number(raid?.earnedGold) || 0;
    const t = Number(raid?.totalGold) || 0;
    earned += e;
    total += t;
    if (raid?.goldBound) {
      earnedBound += e;
      totalBound += t;
    }
  }
  return {
    earned,
    total,
    earnedBound,
    totalBound,
    earnedUnbound: earned - earnedBound,
    totalUnbound: total - totalBound,
  };
}

// Sum gold for a whole account, gating per-character on `isGoldEarner`.
// Lost Ark caps gold-earners at 6 per account/week, so chars without the
// flag are excluded entirely from the rollup. `getRaidsFor` is the same
// callable the view layer uses (already filter-scoped when the caller
// has a raid filter active), so this function inherits the active filter
// without taking it as a separate argument.
function summarizeAccountGold(account, getRaidsFor) {
  let earned = 0;
  let total = 0;
  let earnedBound = 0;
  let totalBound = 0;
  for (const character of account?.characters || []) {
    if (!character?.isGoldEarner) continue;
    const sub = summarizeCharacterGold(getRaidsFor(character));
    earned += sub.earned;
    total += sub.total;
    earnedBound += sub.earnedBound;
    totalBound += sub.totalBound;
  }
  return {
    earned,
    total,
    earnedBound,
    totalBound,
    earnedUnbound: earned - earnedBound,
    totalUnbound: total - totalBound,
  };
}

// Cross-account variant for the multi-roster rollup line. Wraps
// summarizeAccountGold and inherits the same isGoldEarner gate.
function summarizeGlobalGold(accounts, getRaidsFor) {
  let earned = 0;
  let total = 0;
  let earnedBound = 0;
  let totalBound = 0;
  for (const account of accounts || []) {
    const sub = summarizeAccountGold(account, getRaidsFor);
    earned += sub.earned;
    total += sub.total;
    earnedBound += sub.earnedBound;
    totalBound += sub.totalBound;
  }
  return {
    earned,
    total,
    earnedBound,
    totalBound,
    earnedUnbound: earned - earnedBound,
    totalUnbound: total - totalBound,
  };
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
  summarizeCharacterGold,
  summarizeAccountGold,
  summarizeGlobalGold,
  computeRaidGold,
  raidCheckGateIcon,
  RAID_REQUIREMENT_MAP,
};
