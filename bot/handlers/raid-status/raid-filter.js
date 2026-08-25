/**
 * Dropdown state for /raid-status. Raid options summarize the viewer's
 * countable group progress plus discoverable Solo detail; roster options
 * summarize the raids rendered on each account page and keep roster selection
 * aligned with pagination.
 */

const { isSupportClass } = require("../../models/Class");
const {
  areEquivalentRaidModes,
  compareRaidModeOrder,
  isSoloModeKey,
} = require("../../models/Raid");
const { t } = require("../../services/i18n");
const {
  isCountedRaidProgress,
  isGoldReceivingRaid,
} = require("../../utils/raid/common/character");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");

const FILTER_ALL_RAIDS = "__all_raids__";
const FILTER_ALL_ROSTERS = "__all_rosters__";
const FILTER_NO_ROSTERS = "__no_rosters__";

// Normal and Solo share one lockout/progress tier. Once a character queues a
// lateral Normal <-> Solo switch after clearing, the status filter should
// follow that chosen identity immediately; otherwise the dropdown exposes the
// old mode as a ghost option while the character is already presented as
// moving to the equivalent target. Real tier changes (Normal -> Hard, etc.)
// remain on the current mode until weekly reset because their progress is not
// interchangeable.
function getRaidFilterModeKey(raid) {
  const modeKey = raid?.modeKey;
  const pendingModeKey = raid?.pendingModeKey;
  if (
    pendingModeKey &&
    pendingModeKey !== modeKey &&
    areEquivalentRaidModes(modeKey, pendingModeKey)
  ) {
    return pendingModeKey;
  }
  return modeKey;
}

function getRaidFilterKey(raid) {
  return `${raid?.raidKey}:${getRaidFilterModeKey(raid)}`;
}

function isCountedRaidFilterProgress(raid) {
  const modeKey = getRaidFilterModeKey(raid);
  return isCountedRaidProgress(
    modeKey === raid?.modeKey ? raid : { ...raid, modeKey }
  );
}

/**
 * Summarize raids currently presented as Solo across the visible accounts.
 * Solo is detail-only and intentionally excluded from the main progress
 * denominator, so callers need this separate rollup instead of deriving it
 * from totalRaidPending.
 */
function summarizeSoloRaidProgress(accounts, getRaidsFor) {
  let total = 0;
  let completed = 0;
  for (const account of accounts || []) {
    for (const character of account.characters || []) {
      const raids = typeof getRaidsFor === "function" ? getRaidsFor(character) || [] : [];
      for (const raid of raids) {
        if (!isSoloModeKey(getRaidFilterModeKey(raid))) continue;
        total += 1;
        if (raid?.isCompleted === true) completed += 1;
      }
    }
  }
  return { completed, total };
}

function countSoloRaids(accounts, getRaidsFor) {
  return summarizeSoloRaidProgress(accounts, getRaidsFor).total;
}

function buildRaidDropdownState(accounts, getRaidsFor) {
  const raidAggregate = new Map();
  let totalSoloRaids = 0;
  let completedSoloRaids = 0;
  for (const account of accounts || []) {
    for (const ch of account.characters || []) {
      const charIsSupport = isSupportClass(ch?.class);
      for (const raid of getRaidsFor(ch)) {
        const modeKey = getRaidFilterModeKey(raid);
        if (isSoloModeKey(modeKey)) {
          totalSoloRaids += 1;
          if (raid?.isCompleted === true) completedSoloRaids += 1;
        }
        const countsTowardTotal = isCountedRaidFilterProgress(raid);
        // Solo stays discoverable in the raid dropdown even though the
        // all-raids headline and roster counters intentionally exclude it.
        // Other non-counted raids retain the existing hidden behavior.
        if (!countsTowardTotal && !isSoloModeKey(modeKey)) continue;
        const key = getRaidFilterKey(raid);
        let entry = raidAggregate.get(key);
        if (!entry) {
          entry = {
            key,
            // Canonical English label kept for back-compat / debugging.
            // Render-time labels come from getRaidModeLabel(raidKey,
            // modeKey, lang) in buildRaidFilterRow; ordering is by
            // raidKey/modeKey via compareRaidModeOrder below.
            label: getRaidModeLabel(raid.raidKey, modeKey, "en") || raid.raidName,
            raidKey: raid.raidKey,
            modeKey,
            pending: 0,
            supports: 0,
            dps: 0,
            countsTowardTotal,
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
    (sum, r) => sum + (r.countsTowardTotal ? r.pending : 0),
    0
  );
  return { raidDropdownEntries, totalRaidPending, totalSoloRaids, completedSoloRaids };
}

function buildRaidFilterRow(options) {
  const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText,
    raidDropdownEntries,
    totalRaidPending,
    totalSoloRaids = 0,
    completedSoloRaids = 0,
    filterRaidId,
    disabled,
    lang = "vi",
  } = options;

  const allRaidsLabel =
    totalRaidPending === 0
      ? t("raid-status.filter.allRaidsDone", lang, {
          soloDone: completedSoloRaids,
          soloTotal: totalSoloRaids,
        })
      : t("raid-status.filter.allRaidsPending", lang, {
          n: totalRaidPending,
          soloDone: completedSoloRaids,
          soloTotal: totalSoloRaids,
        });

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
      if (
        raidFilter &&
        (getRaidFilterKey(raid) !== raidFilter || !isGoldReceivingRaid(raid))
      ) {
        continue;
      }
      displayMatches += 1;
      // Detail-only raids remain renderable when selected, while roster
      // counters stay aligned with the headline /raid-status progress totals.
      if (!isCountedRaidFilterProgress(raid)) continue;
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
    // The Local Sync preview card renders this same dropdown, but its
    // clicks belong to a different namespace (see DM_BUTTON_PREFIX /
    // STATUS_BUTTON_PREFIX in local-sync/discord-console-ui.js), so the
    // id is an override rather than a constant.
    customId = "status-filter:roster",
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
      .setCustomId(customId)
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
  getRaidFilterKey,
  getRaidFilterModeKey,
  getStatusRosterRaidState,
  countSoloRaids,
  isCountedRaidFilterProgress,
  summarizeSoloRaidProgress,
};
