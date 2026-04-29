const { isSupportClass } = require("../../data/Class");

const FILTER_ALL_RAIDS = "__all_raids__";

function buildRaidDropdownState(accounts, getRaidsFor) {
  const raidAggregate = new Map();
  for (const account of accounts || []) {
    for (const ch of account.characters || []) {
      const charIsSupport = isSupportClass(ch?.class);
      for (const raid of getRaidsFor(ch)) {
        const key = `${raid.raidKey}:${raid.modeKey}`;
        let entry = raidAggregate.get(key);
        if (!entry) {
          entry = {
            key,
            label: raid.raidName,
            raidKey: raid.raidKey,
            modeKey: raid.modeKey,
            pending: 0,
            supports: 0,
            dps: 0,
          };
          raidAggregate.set(key, entry);
        }
        if (!raid.isCompleted) {
          entry.pending += 1;
          if (charIsSupport) entry.supports += 1;
          else entry.dps += 1;
        }
      }
    }
  }

  const raidDropdownEntries = [...raidAggregate.values()].sort(
    (a, b) => b.pending - a.pending || a.label.localeCompare(b.label)
  );
  const totalRaidPending = raidDropdownEntries.reduce(
    (sum, r) => sum + r.pending,
    0
  );

  return { raidDropdownEntries, totalRaidPending };
}

function buildRaidFilterRow(options) {
  const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText,
    raidDropdownEntries,
    totalRaidPending,
    filterRaidId,
    disabled,
  } = options;

  const selectOptions = [
    {
      label: truncateText(
        `All raids (${totalRaidPending === 0 ? "DONE" : `${totalRaidPending} total pending`})`,
        100
      ),
      value: FILTER_ALL_RAIDS,
      emoji: "🌐",
      default: filterRaidId === null,
    },
  ];

  for (const r of raidDropdownEntries.slice(0, 24)) {
    const suffix =
      r.pending === 0
        ? "DONE"
        : `${r.pending} pending · ${r.supports}🛡️ ${r.dps}⚔️`;
    selectOptions.push({
      label: truncateText(`${r.label} (${suffix})`, 100),
      value: r.key,
      emoji: "⚔️",
      default: filterRaidId === r.key,
    });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("status-filter:raid")
      .setPlaceholder("Filter by raid / Lọc theo raid...")
      .setDisabled(disabled)
      .addOptions(selectOptions)
  );
}

module.exports = {
  FILTER_ALL_RAIDS,
  buildRaidDropdownState,
  buildRaidFilterRow,
};
