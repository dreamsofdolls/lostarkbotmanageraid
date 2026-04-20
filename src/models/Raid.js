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
    gates: ["G1", "G2", "G3"],
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
    name: `${raid.label} (>= ${raid.minItemLevel})`,
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

module.exports = {
  RAID_REQUIREMENTS,
  getRaidRequirementChoices,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
};
