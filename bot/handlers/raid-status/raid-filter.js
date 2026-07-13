/**
 * Dropdown state for /raid-status. Raid options summarize the viewer's
 * gold-progress raids; roster options summarize the raids rendered on each
 * account page and keep roster selection aligned with pagination.
 */

const { isSupportClass } = require("../../models/Class");
const { compareRaidModeOrder } = require("../../models/Raid");
const { t } = require("../../services/i18n");
const { isGoldProgressRaid } = require("../../utils/raid/common/character");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");

const FILTER_ALL_RAIDS = "__all_raids__";
const FILTER_ALL_ROSTERS = "__all_rosters__";
const FILTER_NO_ROSTERS = "__no_rosters__";

function buildRaidDropdownState(accounts, getRaidsFor) {
  const raidAggregate = new Map();
  for (const account of accounts || []) {
    for (const ch of account.characters || []) {
      const charIsSupport = isSupportClass(ch?.class);
      for (const raid of getRaidsFor(ch)) {
        if (!isGoldProgressRaid(raid)) continue;
        const key = `${raid.raidKey}:${raid.modeKey}`;
        let entry = raidAggregate.get(key);
        if (!entry) {
          entry = {
            key,
            // Canonical English label kept for back-compat / debugging.
            // Render-time labels come from getRaidModeLabel(raidKey,
            // modeKey, lang) in buildRaidFilterRow; ordering is by
            // raidKey/modeKey via compareRaidModeOrder below.
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

  // Order by canonical raid progression + difficulty (Act 4 -> Kazeros ->
  // Serca -> Horizon, Normal -> Hard -> Nightmare) so the same raid's modes
  // sit together and the list reads predictably. The old pending-desc sort
  // shuffled raids by backlog, which split a raid's modes apart.
  const raidDropdownEntries = [...raidAggregate.values()].sort(compareRaidModeOrder);
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

function getStatusRosterRaidState({ account, raidFilter = null, getRaidsFor }) {
  let pending = 0;
  let success = 0;
  let displayMatches = 0;
  const characters = Array.isArray(account?.characters) ? account.characters : [];
  for (const character of characters) {
    const raids = typeof getRaidsFor === "function" ? getRaidsFor(character) || [] : [];
    for (const raid of raids) {
      if (raidFilter && `${raid.raidKey}:${raid.modeKey}` !== raidFilter) continue;
      displayMatches += 1;
      // Non-gold raids remain selectable because the raid page renders them,
      // while roster counters stay aligned with /raid-status progress totals.
      if (!isGoldProgressRaid(raid)) continue;
      if (raid?.isCompleted === true) success += 1;
      else pending += 1;
    }
  }
  return {
    pending,
    success,
    total: pending + success,
    displayMatches,
  };
}

function buildStatusRosterFilterEntries({
  accounts,
  raidFilter = null,
  getRaidsFor,
}) {
  const entries = [];
  for (let pageIndex = 0; pageIndex < (accounts || []).length; pageIndex += 1) {
    const account = accounts[pageIndex];
    const state = getStatusRosterRaidState({ account, raidFilter, getRaidsFor });
    if (raidFilter && state.displayMatches === 0) continue;
    entries.push({
      pageIndex,
      accountName: String(account?.accountName || ""),
      ...state,
    });
  }
  return entries;
}

function buildStatusRosterFilterRow(options) {
  const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText,
    rosterFilterEntries,
    selectedRosterIndex,
    disabled,
    lang = "vi",
  } = options;
  const entries = Array.isArray(rosterFilterEntries) ? rosterFilterEntries : [];
  let selectOptions;

  if (entries.length === 0) {
    selectOptions = [{
      label: truncateText(t("raid-status.filter.noMatchingRosters", lang), 100),
      value: FILTER_NO_ROSTERS,
      emoji: "\u{1f4c1}",
      default: true,
    }];
  } else {
    const totals = entries.reduce(
      (sum, entry) => ({
        pending: sum.pending + entry.pending,
        success: sum.success + entry.success,
      }),
      { pending: 0, success: 0 }
    );
    selectOptions = [{
      label: truncateText(t("raid-status.filter.allRosters", lang, totals), 100),
      value: FILTER_ALL_ROSTERS,
      emoji: "\u{1f4c2}",
      default: selectedRosterIndex === null,
    }];

    const visibleEntries = entries.slice(0, 24);
    if (
      Number.isInteger(selectedRosterIndex) &&
      !visibleEntries.some((entry) => entry.pageIndex === selectedRosterIndex)
    ) {
      const selected = entries.find((entry) => entry.pageIndex === selectedRosterIndex);
      if (selected) visibleEntries[visibleEntries.length - 1] = selected;
    }

    for (const entry of visibleEntries) {
      selectOptions.push({
        label: truncateText(
          t("raid-status.filter.rosterState", lang, {
            name: entry.accountName || t("raid-status.filter.unnamedRoster", lang),
            pending: entry.pending,
            success: entry.success,
          }),
          100
        ),
        value: String(entry.pageIndex),
        emoji: "\u{1f4c1}",
        default: selectedRosterIndex === entry.pageIndex,
      });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("status-filter:roster")
      .setPlaceholder(t("raid-status.filter.rosterPlaceholder", lang))
      .setDisabled(disabled || entries.length === 0)
      .addOptions(selectOptions)
  );
}

module.exports = {
  FILTER_ALL_RAIDS,
  FILTER_ALL_ROSTERS,
  FILTER_NO_ROSTERS,
  buildRaidDropdownState,
  buildRaidFilterRow,
  buildStatusRosterFilterEntries,
  buildStatusRosterFilterRow,
  getStatusRosterRaidState,
};
