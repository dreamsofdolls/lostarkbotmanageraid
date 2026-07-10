"use strict";

const { compareRaidModeOrder } = require("../../../models/Raid");

const FILTER_ALL = "__all__";
const FILTER_ALL_RAIDS = "__all_raids__";
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
  FILTER_STATUS,
  buildAllModeRaidFilterRow,
  buildAllModeStatusFilterRow,
  buildAllModeUserFilterRow,
  normalizeAllModeStatusFilter,
  raidMatchesStatusFilter,
};
