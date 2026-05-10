const { isSupportClass } = require("../../models/Class");
const { t } = require("../../services/i18n");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");

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
            // Canonical English label kept here so the secondary
            // sort below stays stable across locale switches (a
            // locale-aware sort would re-shuffle entries when the
            // viewer flips between vi and jp). Render-time labels
            // come from getRaidModeLabel(raidKey, modeKey, lang) in
            // buildRaidFilterRow below.
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
    lang = "vi",
  } = options;

  const allRaidsLabel =
    totalRaidPending === 0
      ? t("raid-status.filter.allRaidsDone", lang)
      : t("raid-status.filter.allRaidsPending", lang, { n: totalRaidPending });

  const selectOptions = [
    {
      label: truncateText(allRaidsLabel, 100),
      value: FILTER_ALL_RAIDS,
      emoji: "🌐",
      default: filterRaidId === null,
    },
  ];

  for (const r of raidDropdownEntries.slice(0, 24)) {
    // Resolve the user-visible label per locale. The aggregator above
    // stored `r.label = raid.raidName` (canonical EN) only for stable
    // sorting - the actual dropdown label comes from getRaidModeLabel
    // so JP users see "アクト4 ノーマル" instead of "Act 4".
    const localizedLabel = getRaidModeLabel(r.raidKey, r.modeKey, lang);
    const optionLabel =
      r.pending === 0
        ? t("raid-status.filter.raidEntryDone", lang, { label: localizedLabel })
        : t("raid-status.filter.raidEntryPending", lang, {
            label: localizedLabel,
            n: r.pending,
            supports: r.supports,
            dps: r.dps,
          });
    selectOptions.push({
      label: truncateText(optionLabel, 100),
      value: r.key,
      emoji: "⚔️",
      default: filterRaidId === r.key,
    });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("status-filter:raid")
      .setPlaceholder(t("raid-status.filter.placeholder", lang))
      .setDisabled(disabled)
      .addOptions(selectOptions)
  );
}

module.exports = {
  FILTER_ALL_RAIDS,
  buildRaidDropdownState,
  buildRaidFilterRow,
};
