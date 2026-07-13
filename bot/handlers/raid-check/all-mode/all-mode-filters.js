"use strict";

const { compareRaidModeOrder } = require("../../../models/Raid");
const { isRaidCheckVisibleRaid } = require("../visibility");

const FILTER_ALL = "__all__";
const FILTER_ALL_RAIDS = "__all_raids__";
const FILTER_ALL_ROSTERS = "__all_rosters__";
const FILTER_NO_ROSTERS = "__no_rosters__";
const FILTER_STATUS = Object.freeze({
  all: "all",
  pending: "pending",
  success: "success",
});
const FILTER_STATUS_VALUES = new Set(Object.values(FILTER_STATUS));

function normalizeAllModeStatusFilter(value) {
  return FILTER_STATUS_VALUES.has(value)
    ? value
    : FILTER_STATUS.all;
}

function raidMatchesStatusFilter(raid, filterStatus) {
  const status = normalizeAllModeStatusFilter(filterStatus);
  if (status === FILTER_STATUS.all) return true;

  const isCompleted = raid?.isCompleted === true;
  return status === FILTER_STATUS.success ? isCompleted : !isCompleted;
}

function getAllModeRosterRaidState({
  page,
  raidFilter = null,
  getStatusRaidsForCharacter,
}) {
  let pending = 0;
  let success = 0;
  const characters = Array.isArray(page?.account?.characters)
    ? page.account.characters
    : [];
  for (const character of characters) {
    const raids = typeof getStatusRaidsForCharacter === "function"
      ? getStatusRaidsForCharacter(character) || []
      : [];
    for (const raid of raids) {
      if (!isRaidCheckVisibleRaid(raid)) continue;
      if (raidFilter && `${raid.raidKey}:${raid.modeKey}` !== raidFilter) continue;
      if (raid?.isCompleted === true) success += 1;
      else pending += 1;
    }
  }
  return { pending, success, total: pending + success };
}

function rosterStateMatchesStatus(state, filterStatus) {
  const status = normalizeAllModeStatusFilter(filterStatus);
  if (status === FILTER_STATUS.pending) return state.pending > 0;
  if (status === FILTER_STATUS.success) return state.success > 0;
  return state.total > 0;
}

function getAllModeRosterFilterEntries({
  pagesData,
  filterUserId,
  filterRaidId = null,
  filterStatus = FILTER_STATUS.all,
  getStatusRaidsForCharacter,
  applyRaidEligibility = true,
}) {
  if (!filterUserId) return [];
  const activeStatus = normalizeAllModeStatusFilter(filterStatus);
  const hasActiveRaidFilter = Boolean(filterRaidId) || activeStatus !== FILTER_STATUS.all;
  const entries = [];
  for (let pageIndex = 0; pageIndex < (pagesData || []).length; pageIndex += 1) {
    const page = pagesData[pageIndex];
    if (page?.userDoc?.discordId !== filterUserId) continue;
    const state = getAllModeRosterRaidState({
      page,
      raidFilter: filterRaidId,
      getStatusRaidsForCharacter,
    });
    if (
      applyRaidEligibility &&
      hasActiveRaidFilter &&
      !rosterStateMatchesStatus(state, activeStatus)
    ) {
      continue;
    }
    entries.push({
      pageIndex,
      accountName: String(page?.account?.accountName || ""),
      ...state,
    });
  }
  return entries;
}

function filterAllModePageIndices({
  pagesData,
  filterUserId = null,
  filterRosterIndex = null,
  filterRaidId = null,
  filterStatus = FILTER_STATUS.all,
  getStatusRaidsForCharacter,
  applyRaidEligibility = true,
}) {
  const activeStatus = normalizeAllModeStatusFilter(filterStatus);
  const hasActiveRaidFilter = Boolean(filterRaidId) || activeStatus !== FILTER_STATUS.all;
  const filteredIndices = [];
  for (let pageIndex = 0; pageIndex < (pagesData || []).length; pageIndex += 1) {
    const page = pagesData[pageIndex];
    if (filterUserId && page?.userDoc?.discordId !== filterUserId) continue;
    if (applyRaidEligibility && hasActiveRaidFilter) {
      const state = getAllModeRosterRaidState({
        page,
        raidFilter: filterRaidId,
        getStatusRaidsForCharacter,
      });
      if (!rosterStateMatchesStatus(state, activeStatus)) continue;
    }
    filteredIndices.push(pageIndex);
  }

  let effectiveRosterIndex = Number.isInteger(filterRosterIndex)
    ? filterRosterIndex
    : null;
  if (
    effectiveRosterIndex !== null &&
    !filteredIndices.includes(effectiveRosterIndex)
  ) {
    effectiveRosterIndex = null;
  }
  return { filteredIndices, filterRosterIndex: effectiveRosterIndex };
}

function resolveAllModeLocalPage({
  filteredIndices,
  filterRosterIndex = null,
  currentLocalPage = 0,
  resetPage = true,
}) {
  const pageIndices = Array.isArray(filteredIndices) ? filteredIndices : [];
  if (Number.isInteger(filterRosterIndex)) {
    const selectedLocalPage = pageIndices.indexOf(filterRosterIndex);
    if (selectedLocalPage >= 0) return selectedLocalPage;
  }
  if (resetPage) return 0;
  return Math.max(
    0,
    Math.min(currentLocalPage, Math.max(0, pageIndices.length - 1))
  );
}

function getAllModeRosterSelectionForPage({
  filterUserId,
  filteredIndices,
  currentLocalPage,
}) {
  if (!filterUserId) return null;
  const pageIndex = filteredIndices?.[currentLocalPage];
  return Number.isInteger(pageIndex) ? pageIndex : null;
}

function buildAllModeUserFilterRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  authorMeta,
  computePendingAggregate,
  disabled,
  filterRaidId,
  filterUserId,
  lang,
  t,
  truncateText,
  visibleUserIds,
}) {
  const { perUserPending, totalPending } = computePendingAggregate({
    raidFilter: filterRaidId,
    userFilter: null,
  });
  const options = [
    {
      label: truncateText(
        totalPending === 0
          ? t("raid-check.filter.allUsersDone", lang)
          : t("raid-check.filter.allUsersPending", lang, { n: totalPending }),
        100
      ),
      value: FILTER_ALL,
      emoji: "\u{1f310}",
      default: filterUserId === null,
    },
  ];
  const sortedUsers = visibleUserIds
    .map((discordId) => {
      const tally = perUserPending.get(discordId) || { count: 0, supports: 0, dps: 0 };
      return {
        discordId,
        pending: tally.count,
        supports: tally.supports,
        dps: tally.dps,
        displayName: authorMeta.get(discordId)?.displayName || discordId,
      };
    })
    .sort(
      (a, b) =>
        b.pending - a.pending || a.displayName.localeCompare(b.displayName)
    );
  for (const user of sortedUsers.slice(0, 24)) {
    const label = user.pending === 0
      ? t("raid-check.filter.userDone", lang, { name: user.displayName })
      : t("raid-check.filter.userPending", lang, {
          name: user.displayName,
          n: user.pending,
          supports: user.supports,
          dps: user.dps,
        });
    options.push({
      label: truncateText(label, 100),
      value: user.discordId,
      emoji: "\u{1f464}",
      default: filterUserId === user.discordId,
    });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("raid-check-all-filter:user")
      .setPlaceholder(t("raid-check.filter.userPlaceholder", lang))
      .setDisabled(disabled)
      .addOptions(options)
  );
}

function buildAllModeRaidFilterRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  computePendingAggregate,
  disabled,
  filterRaidId,
  filterUserId,
  lang,
  t,
  truncateText,
}) {
  const { perRaidPending, totalPending } = computePendingAggregate({
    raidFilter: null,
    userFilter: filterUserId,
  });
  // Canonical raid progression + difficulty order (shared with /raid-status's
  // filter) so a raid's modes stay grouped instead of scattering by backlog.
  const raidEntries = [...perRaidPending.values()].sort(compareRaidModeOrder);
  const options = [
    {
      label: truncateText(
        totalPending === 0
          ? t("raid-check.filter.allRaidsDone", lang)
          : t("raid-check.filter.allRaidsPending", lang, { n: totalPending }),
        100
      ),
      value: FILTER_ALL_RAIDS,
      emoji: "\u{1f310}",
      default: filterRaidId === null,
    },
  ];
  for (const raid of raidEntries.slice(0, 24)) {
    const label = raid.pending === 0
      ? t("raid-check.filter.raidDone", lang, { label: raid.label })
      : t("raid-check.filter.raidPending", lang, {
          label: raid.label,
          n: raid.pending,
          supports: raid.supports,
          dps: raid.dps,
        });
    options.push({
      label: truncateText(label, 100),
      value: raid.key,
      emoji: "\u2694\ufe0f",
      default: filterRaidId === raid.key,
    });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("raid-check-all-filter:raid")
      .setPlaceholder(t("raid-check.filter.raidPlaceholder", lang))
      .setDisabled(disabled)
      .addOptions(options)
  );
}

function buildAllModeRosterFilterRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  disabled,
  filterRaidId,
  filterRosterIndex,
  filterStatus,
  filterUserId,
  getStatusRaidsForCharacter,
  lang,
  pagesData,
  t,
  truncateText,
  applyRaidEligibility = true,
}) {
  const entries = getAllModeRosterFilterEntries({
    pagesData,
    filterUserId,
    filterRaidId,
    filterStatus,
    getStatusRaidsForCharacter,
    applyRaidEligibility,
  });
  let options;
  if (entries.length === 0) {
    options = [{
      label: truncateText(t("raid-check.filter.noMatchingRosters", lang), 100),
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
    options = [{
      label: truncateText(
        t("raid-check.filter.allRosters", lang, totals),
        100
      ),
      value: FILTER_ALL_ROSTERS,
      emoji: "\u{1f4c2}",
      default: filterRosterIndex === null,
    }];
    const visibleEntries = entries.slice(0, 24);
    if (
      Number.isInteger(filterRosterIndex) &&
      !visibleEntries.some((entry) => entry.pageIndex === filterRosterIndex)
    ) {
      const selected = entries.find((entry) => entry.pageIndex === filterRosterIndex);
      if (selected) visibleEntries[visibleEntries.length - 1] = selected;
    }
    for (const entry of visibleEntries) {
      options.push({
        label: truncateText(
          t("raid-check.filter.rosterState", lang, {
            name: entry.accountName || t("raid-check.allMode.unnamedRoster", lang),
            pending: entry.pending,
            success: entry.success,
          }),
          100
        ),
        value: String(entry.pageIndex),
        emoji: "\u{1f4c1}",
        default: filterRosterIndex === entry.pageIndex,
      });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("raid-check-all-filter:roster")
      .setPlaceholder(t("raid-check.filter.rosterPlaceholder", lang))
      .setDisabled(disabled || entries.length === 0)
      .addOptions(options)
  );
}

function buildAllModeStatusFilterRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  disabled,
  filterStatus,
  lang,
  t,
}) {
  const activeStatus = normalizeAllModeStatusFilter(filterStatus);
  const options = [
    {
      label: t("raid-check.filter.statusAll", lang),
      value: FILTER_STATUS.all,
      emoji: "\u{1f310}",
    },
    {
      label: t("raid-check.filter.statusPending", lang),
      value: FILTER_STATUS.pending,
      emoji: "\u23f3",
    },
    {
      label: t("raid-check.filter.statusSuccess", lang),
      value: FILTER_STATUS.success,
      emoji: "\u2705",
    },
  ].map((option) => ({
    ...option,
    default: option.value === activeStatus,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("raid-check-all-filter:status")
      .setPlaceholder(t("raid-check.filter.statusPlaceholder", lang))
      .setDisabled(disabled)
      .addOptions(options)
  );
}

module.exports = {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  FILTER_ALL_ROSTERS,
  FILTER_NO_ROSTERS,
  FILTER_STATUS,
  buildAllModeRaidFilterRow,
  buildAllModeRosterFilterRow,
  buildAllModeStatusFilterRow,
  buildAllModeUserFilterRow,
  filterAllModePageIndices,
  getAllModeRosterFilterEntries,
  getAllModeRosterSelectionForPage,
  normalizeAllModeStatusFilter,
  raidMatchesStatusFilter,
  resolveAllModeLocalPage,
};
