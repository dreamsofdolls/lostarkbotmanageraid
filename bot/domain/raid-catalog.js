"use strict";

// `gold` per (raid, mode, gate) is the raid's INTRINSIC (full, tradeable) weekly
// gold - kept as the base value so it survives policy changes. `boundGold`, when
// present, is the current roster-bound conversion applied on top: the gold a
// character actually earns becomes `base * boundGold.factor` and is roster-bound
// (can't be traded/sold/sent). Smilegate periodically halves normal-raid gold to
// bound to curb inflation; if a future round changes the cut, edit only the
// factor (or add `boundGold` to more modes) - the base stays put. Absent =
// full, unbound. Only chars with `isGoldEarner=true` actually receive the gold.
const RAID_REQUIREMENTS = {
  armoche: {
    label: "Act 4",
    partySize: 8,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1700, gold: { G1: 12500, G2: 20500 }, boundGold: { factor: 0.5 } },
      hard: { label: "Hard", minItemLevel: 1720, gold: { G1: 15000, G2: 27000 } },
    },
  },
  kazeros: {
    label: "Kazeros",
    partySize: 8,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 26000 }, boundGold: { factor: 0.5 } },
      hard: { label: "Hard", minItemLevel: 1730, gold: { G1: 17000, G2: 35000 } },
    },
  },
  serca: {
    label: "Serca",
    partySize: 4,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 21000 }, boundGold: { factor: 0.5 } },
      hard: { label: "Hard", minItemLevel: 1730, gold: { G1: 17500, G2: 26500 } },
      nightmare: { label: "Nightmare", minItemLevel: 1740, gold: { G1: 21000, G2: 33000 } },
    },
  },
};

function getGatesForRaid(raidKey) {
  const raid = RAID_REQUIREMENTS[raidKey];
  if (!raid || !Array.isArray(raid.gates) || raid.gates.length === 0) return ["G1", "G2"];
  return [...raid.gates];
}

function getRaidPartySize(raidKey) {
  const size = Number(RAID_REQUIREMENTS[raidKey]?.partySize);
  if (size === 4 || size === 8) return size;
  throw new Error(`[raid-catalog] unsupported raid party size for: ${raidKey}`);
}

function buildRaidRequirementList() {
  const list = [];
  for (const [raidKey, raidGroup] of Object.entries(RAID_REQUIREMENTS)) {
    for (const [modeKey, mode] of Object.entries(raidGroup.modes || {})) {
      list.push({
        value: `${raidKey}_${modeKey}`,
        label: `${raidGroup.label} ${mode.label}`,
        minItemLevel: mode.minItemLevel,
        raidKey,
        modeKey,
      });
    }
  }
  return list;
}

function getRaidRequirementList() {
  return buildRaidRequirementList().map(({ value, ...raid }) => raid);
}

function getRaidRequirementMap() {
  return Object.fromEntries(
    buildRaidRequirementList().map((raid) => [raid.value, {
      label: raid.label,
      minItemLevel: raid.minItemLevel,
      raidKey: raid.raidKey,
      modeKey: raid.modeKey,
    }])
  );
}

// Boss display name -> (raidKey, gate). Difficulty comes from the log row,
// so one boss can map to the same gate across modes.
const BOSS_TO_RAID_GATE = new Map([
  ["Brelshaza, Ember in the Ashes", { raidKey: "armoche", gate: "G1" }],
  ["Armoche, Sentinel of the Abyss", { raidKey: "armoche", gate: "G2" }],

  ["Abyss Lord Kazeros", { raidKey: "kazeros", gate: "G1" }],
  ["Archdemon Kazeros", { raidKey: "kazeros", gate: "G2" }],
  ["Death Incarnate Kazeros", { raidKey: "kazeros", gate: "G2" }],

  ["Witch of Agony, Serca", { raidKey: "serca", gate: "G1" }],
  ["Corvus Tul Rak", { raidKey: "serca", gate: "G2" }],
]);

function getRaidGateForBoss(bossName) {
  return BOSS_TO_RAID_GATE.get(bossName) || null;
}

function getGoldForGate(raidKey, modeKey, gate) {
  const mode = RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey];
  if (!mode || !mode.gold) return 0;
  const base = Number(mode.gold[gate]) || 0;
  // Apply the bound-conversion factor when present (e.g. normal raids at 0.5).
  // Round to whole gold; all current base*factor pairs are already integers.
  const factor = mode.boundGold ? Number(mode.boundGold.factor) : 1;
  return Math.round(base * (Number.isFinite(factor) ? factor : 1));
}

function getGoldForRaid(raidKey, modeKey) {
  const gates = getGatesForRaid(raidKey);
  let total = 0;
  for (const gate of gates) total += getGoldForGate(raidKey, modeKey, gate);
  return total;
}

// Whether a (raid, mode)'s gold is roster-bound (non-tradeable). Boundness is a
// property of the whole mode (driven by the presence of a `boundGold` conversion),
// not a per-gate split, so a single check is enough.
function isGoldBound(raidKey, modeKey) {
  return !!RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey]?.boundGold;
}

module.exports = {
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getRaidPartySize,
  getGatesForRaid,
  getRaidGateForBoss,
  BOSS_TO_RAID_GATE,
  getGoldForGate,
  getGoldForRaid,
  isGoldBound,
};
