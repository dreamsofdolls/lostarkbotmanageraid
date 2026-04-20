const RAID_REQUIREMENTS = {
  act4: {
    label: "Act 4",
    modes: {
      normal: { label: "Normal", minItemLevel: 1700 },
      hard: { label: "Hard", minItemLevel: 1720 },
    },
  },
  kazeros: {
    label: "Kazeros",
    modes: {
      normal: { label: "Normal", minItemLevel: 1710 },
      hard: { label: "Hard", minItemLevel: 1730 },
    },
  },
  serca: {
    label: "Serca",
    modes: {
      normal: { label: "Normal", minItemLevel: 1710 },
      hard: { label: "Hard", minItemLevel: 1730 },
      nightmare: { label: "Nightmare", minItemLevel: 1740 },
    },
  },
};

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
};
