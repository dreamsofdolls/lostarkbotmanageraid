const RAID_REQUIREMENTS = {
  armoche: {
    label: "Act 4",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1700 },
      hard: { label: "Hard", minItemLevel: 1720 },
    },
  },
  kazeros: {
    label: "Kazeros",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710 },
      hard: { label: "Hard", minItemLevel: 1730 },
    },
  },
  serca: {
    label: "Serca",
    gates: ["G1", "G2"],
    modes: {
      normal: { label: "Normal", minItemLevel: 1710 },
      hard: { label: "Hard", minItemLevel: 1730 },
      nightmare: { label: "Nightmare", minItemLevel: 1740 },
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

function getRaidRequirementChoices() {
  return buildRaidRequirementList().map((raid) => ({
    name: `${raid.label} · ${raid.minItemLevel}+`,
    value: raid.value,
  }));
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

module.exports = {
  RAID_REQUIREMENTS,
  getRaidRequirementChoices,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
  getRaidGateForBoss,
  BOSS_TO_RAID_GATE,
};
