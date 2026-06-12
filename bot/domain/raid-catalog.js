"use strict";

// `gold` per (raid, mode, gate) is the raid's base weekly gold. `goldFactor`
// keeps older reduced-gold modes from losing their original values. `boundGold`
// is reserved for modes whose paid gold is fully character/roster-bound
// (unbound value = 0), so auto gold-slot logic can skip only those modes.
const CHARACTER_BOUND_GOLD = Object.freeze({ factor: 1 });

const RAID_REQUIREMENTS = {
  armoche: {
    label: "Act 4",
    partySize: 8,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1700, gold: { G1: 12500, G2: 20500 }, goldFactor: 0.5 },
      hard: { label: "Hard", minItemLevel: 1720, gold: { G1: 15000, G2: 27000 } },
    },
  },
  kazeros: {
    label: "Kazeros",
    partySize: 8,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 26000 }, goldFactor: 0.5 },
      hard: { label: "Hard", minItemLevel: 1730, gold: { G1: 17000, G2: 35000 } },
    },
  },
  serca: {
    label: "Serca",
    partySize: 4,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 21000 }, goldFactor: 0.5 },
      hard: { label: "Hard", minItemLevel: 1730, gold: { G1: 17500, G2: 26500 } },
      nightmare: { label: "Nightmare", minItemLevel: 1740, gold: { G1: 21000, G2: 33000 } },
    },
  },
  horizon: {
    label: "Horizon",
    partySize: 4,
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Level 1", minItemLevel: 1700, gold: { G1: 13500, G2: 16500 }, boundGold: CHARACTER_BOUND_GOLD },
      hard: { label: "Level 2", minItemLevel: 1720, gold: { G1: 16000, G2: 24000 }, boundGold: CHARACTER_BOUND_GOLD },
      nightmare: { label: "Level 3", minItemLevel: 1750, gold: { G1: 20000, G2: 30000 }, boundGold: CHARACTER_BOUND_GOLD },
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

  ["Archbishop Arcenos", { raidKey: "horizon", gate: "G1" }],
  ["Arcenos, Vanguard of Fanaticism", { raidKey: "horizon", gate: "G2" }],
]);

function getRaidGateForBoss(bossName) {
  return BOSS_TO_RAID_GATE.get(bossName) || null;
}

function getGoldForGate(raidKey, modeKey, gate) {
  const mode = RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey];
  if (!mode || !mode.gold) return 0;
  const base = Number(mode.gold[gate]) || 0;
  // Apply reduction/full-bound factors when present. Round defensively; all
  // current base*factor pairs are already whole gold.
  const factor = Number(mode.goldFactor ?? mode.boundGold?.factor ?? 1);
  return Math.round(base * (Number.isFinite(factor) ? factor : 1));
}

function getGoldForRaid(raidKey, modeKey) {
  const gates = getGatesForRaid(raidKey);
  let total = 0;
  for (const gate of gates) total += getGoldForGate(raidKey, modeKey, gate);
  return total;
}

// Whether a (raid, mode)'s paid gold is fully bound (unbound value = 0).
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
