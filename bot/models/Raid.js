// `gold` per (raid, mode, gate) is the unbound weekly gold a character
// earns by clearing that gate. Values match the in-game reward table; see
// CHANGELOG entry on the day this was wired in for the source screenshots.
// Only chars with `isGoldEarner=true` actually receive the gold (LA caps
// at 6 gold-earners per account per week); the view layer applies that
// gate when rolling up totals - the values here stay raid-intrinsic so
// they don't depend on roster state.
const RAID_REQUIREMENTS = {
  armoche: {
    label: "Act 4",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1700, gold: { G1: 12500, G2: 20500 } },
      hard: { label: "Hard", minItemLevel: 1720, gold: { G1: 15000, G2: 27000 } },
    },
  },
  kazeros: {
    label: "Kazeros",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 26000 } },
      hard: { label: "Hard", minItemLevel: 1730, gold: { G1: 17000, G2: 35000 } },
    },
  },
  serca: {
    label: "Serca",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710, gold: { G1: 14000, G2: 21000 } },
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

// Boss name → (raidKey, gate) map used by the `/raid-auto-manage` sync
// flow. lostark.bible logs API returns each clear with a `boss` field
// (e.g. "Armoche, Sentinel of the Abyss"); this table says which raid
// and gate that boss represents. Difficulty comes from the log entry's
// `difficulty` field directly, so one boss can map to the same gate
// across modes (e.g. Kazeros G2 is "Archdemon Kazeros" on Normal and
// "Death Incarnate Kazeros" on Hard/Nightmare — both → kazeros G2).
const BOSS_TO_RAID_GATE = new Map([
  // Armoche (Act 4)
  ["Brelshaza, Ember in the Ashes", { raidKey: "armoche", gate: "G1" }],
  ["Armoche, Sentinel of the Abyss", { raidKey: "armoche", gate: "G2" }],

  // Kazeros — G2 has two boss names depending on difficulty
  ["Abyss Lord Kazeros", { raidKey: "kazeros", gate: "G1" }],
  ["Archdemon Kazeros", { raidKey: "kazeros", gate: "G2" }],
  ["Death Incarnate Kazeros", { raidKey: "kazeros", gate: "G2" }],

  // Serca
  ["Witch of Agony, Serca", { raidKey: "serca", gate: "G1" }],
  ["Corvus Tul Rak", { raidKey: "serca", gate: "G2" }],
]);

function getRaidGateForBoss(bossName) {
  return BOSS_TO_RAID_GATE.get(bossName) || null;
}

// Look up the unbound gold reward for a single (raid, mode, gate). Returns
// 0 for any unknown combo so callers can sum without null-guarding every
// entry - a missing mapping is a data error in RAID_REQUIREMENTS, not a
// runtime concern for the consumer.
function getGoldForGate(raidKey, modeKey, gate) {
  const mode = RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey];
  if (!mode || !mode.gold) return 0;
  return Number(mode.gold[gate]) || 0;
}

// Sum gold across every gate of a (raid, mode) pair. Used when the
// caller wants the headline total for a raid card (e.g. "26,000G / 35,000G").
function getGoldForRaid(raidKey, modeKey) {
  const gates = getGatesForRaid(raidKey);
  let total = 0;
  for (const gate of gates) total += getGoldForGate(raidKey, modeKey, gate);
  return total;
}

module.exports = {
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
  getRaidGateForBoss,
  BOSS_TO_RAID_GATE,
  getGoldForGate,
  getGoldForRaid,
};
