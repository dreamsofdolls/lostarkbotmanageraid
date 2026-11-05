"use strict";

// One summary notice per gold-view save: which characters changed and how,
// which picks were skipped and why. Reads only the bulk writers' results.

const { RAID_ORDER } = require("../../../domain/raid-catalog");
const {
  getRaidLabel,
  getRaidSpecificModeLabel,
} = require("../../../utils/raid/common/labels");
const { NoticeKind, truncateText } = require("../../../utils/raid/common/shared");
const { t } = require("../../../services/i18n");
const { GOLD_RECEIVE_AUTO } = require("./gold-actions");

const DESCRIPTION_LIMIT = 4096;
const RAID_RANK = new Map(RAID_ORDER.map((raidKey, index) => [raidKey, index]));

// Changed outcomes in display order, each with its locale template.
const MODE_OUTCOME_KEYS = new Map([
  ["immediate", "outcomeNow"],
  ["deferred", "outcomeReset"],
  ["cancelled", "outcomeCancelled"],
]);
const MODE_OUTCOME_ORDER = [...MODE_OUTCOME_KEYS.keys()];

const TOUCHED_GOLD_STATUSES = new Set(["changed", "pinned"]);

function goldViewText(key, lang, params) {
  return t(`raid-status.goldView.${key}`, lang, params);
}

function raidLabel(raidKey, lang) {
  return getRaidLabel(raidKey, lang) || raidKey;
}

function modeLabel(raidKey, modeKey, lang) {
  return getRaidSpecificModeLabel(raidKey, modeKey, lang) || modeKey;
}

function byRaidOrder(a, b) {
  return (RAID_RANK.get(a) ?? RAID_ORDER.length) - (RAID_RANK.get(b) ?? RAID_ORDER.length);
}

function characterPrefix(entry, getClassEmoji) {
  const icon = entry.className ? getClassEmoji(entry.className) : "";
  return `${icon ? `${icon} ` : ""}**${entry.name}**`;
}

function clampDescription(lines) {
  return truncateText(lines.filter(Boolean).join("\n"), DESCRIPTION_LIMIT);
}

function missingLine(entries, isMissing, lang) {
  const names = entries.filter(isMissing).map((entry) => entry.name);
  return names.length > 0 ? goldViewText("missingLine", lang, { names: names.join(", ") }) : "";
}

// "Act 4, Kazeros → Hard · đổi ngay; Belgardin → Hard · sau reset"
function modeChangeGroups(outcomes, lang) {
  const changed = outcomes
    .filter((item) => MODE_OUTCOME_KEYS.has(item.outcome))
    .sort((a, b) => (
      MODE_OUTCOME_ORDER.indexOf(a.outcome) - MODE_OUTCOME_ORDER.indexOf(b.outcome)
      || byRaidOrder(a.raidKey, b.raidKey)
    ));
  const groups = new Map();
  for (const item of changed) {
    const mode = item.outcome === "cancelled" ? "" : modeLabel(item.raidKey, item.modeKey, lang);
    const groupKey = `${item.outcome}|${mode}`;
    const group = groups.get(groupKey) || { outcome: item.outcome, mode, raids: [] };
    group.raids.push(raidLabel(item.raidKey, lang));
    groups.set(groupKey, group);
  }
  return [...groups.values()].map((group) => goldViewText(
    MODE_OUTCOME_KEYS.get(group.outcome),
    lang,
    { raids: group.raids.join(", "), mode: group.mode }
  ));
}

function skippedModeItems(entry, lang) {
  return (entry.outcomes || [])
    .filter((item) => item.outcome === "ineligible")
    .map((item) => goldViewText("skippedItem", lang, {
      name: entry.name,
      raid: `${raidLabel(item.raidKey, lang)} ${modeLabel(item.raidKey, item.modeKey, lang)}`,
      need: item.minItemLevel,
      ilvl: entry.itemLevel,
    }));
}

/**
 * Summary of one difficulty save across the selected characters.
 * @param {object} args
 * @param {{results: object[]}} args.result - from saveBulkRaidModes
 * @param {Array<{raidKey: string, keptModeKey: string}>} [args.collapsed] - from parseGoldModeValues
 * @param {string} args.lang - viewer language
 * @param {(className: string) => string} args.getClassEmoji - class icon lookup
 * @returns {{kind: "done"|"input", title: string, description: string}|null}
 *   input when nothing changed but a pick was skipped or a character is
 *   missing; null when nothing changed and nothing was ineligible or missing
 */
function buildModeSummaryNotice({ result, collapsed = [], lang, getClassEmoji }) {
  const entries = Array.isArray(result?.results) ? result.results : [];
  const present = entries.filter((entry) => !entry.missing);
  const changedLines = present
    .map((entry) => ({ entry, groups: modeChangeGroups(entry.outcomes || [], lang) }))
    .filter(({ groups }) => groups.length > 0)
    .map(({ entry, groups }) => `${characterPrefix(entry, getClassEmoji)}: ${groups.join("; ")}`);
  const skipped = present.flatMap((entry) => skippedModeItems(entry, lang));
  const missing = missingLine(entries, (entry) => entry.missing, lang);

  const tailLines = [
    skipped.length > 0 ? goldViewText("skippedLine", lang, { items: skipped.join("; ") }) : "",
    ...collapsed.map((item) => goldViewText("collapsedLine", lang, {
      raid: raidLabel(item.raidKey, lang),
      mode: modeLabel(item.raidKey, item.keptModeKey, lang),
    })),
    missing,
  ];

  if (changedLines.length > 0) {
    return {
      kind: NoticeKind.DONE,
      title: goldViewText("modeSummaryTitle", lang, { n: changedLines.length }),
      description: clampDescription([...changedLines, ...tailLines]),
    };
  }
  if (skipped.length === 0 && !missing) return null;
  return {
    kind: NoticeKind.INPUT,
    title: goldViewText("nothingChangedTitle", lang),
    description: clampDescription([goldViewText("nothingChangedDescription", lang), ...tailLines]),
  };
}

function raidList(raidKeys, lang, separator = " · ") {
  return raidKeys.map((raidKey) => raidLabel(raidKey, lang)).join(separator);
}

// "Serca vào, Belgardin ra", or the kept set for a character pinned by hand.
function goldChangeText(entry, lang) {
  if (entry.status === "pinned") {
    return goldViewText("goldKeptPinned", lang, { raids: raidList(entry.kept, lang) });
  }
  const sorted = (raidKeys) => [...raidKeys].sort(byRaidOrder);
  return [
    entry.added.length > 0 ? goldViewText("goldIn", lang, { raids: raidList(sorted(entry.added), lang, ", ") }) : "",
    entry.removed.length > 0 ? goldViewText("goldOut", lang, { raids: raidList(sorted(entry.removed), lang, ", ") }) : "",
  ].filter(Boolean).join(", ");
}

function goldSkippedTail(entry, lang) {
  return entry.skipped.length > 0
    ? goldViewText("goldSkippedRaids", lang, { raids: raidList(entry.skipped, lang, ", ") })
    : "";
}

/**
 * Summary of one gold-set (or auto) save across the selected characters.
 * @param {object} args
 * @param {{results: object[]}} args.result - from saveBulkGoldReceive
 * @param {{kind: "auto"}|{kind: "set", raidKeys: string[]}} args.receive - from parseGoldReceiveValues
 * @param {boolean} [args.ignoredTicks] - raids were ticked together with auto
 * @param {string} args.lang - viewer language
 * @param {(className: string) => string} args.getClassEmoji - class icon lookup
 * @returns {{kind: "done"|"input", title: string, description: string}|null}
 *   input when nothing changed but a character was left as is or is missing;
 *   null when nothing changed and nobody needs naming
 */
function buildGoldReceiveSummaryNotice({ result, receive, ignoredTicks = false, lang, getClassEmoji }) {
  const entries = Array.isArray(result?.results) ? result.results : [];
  const touched = entries.filter((entry) => TOUCHED_GOLD_STATUSES.has(entry.status));
  const missing = missingLine(entries, (entry) => entry.status === "missing", lang);
  // Characters the set left as they were although some ticked raids were
  // skipped for them, typically because they have none of those raids.
  const keptLines = entries
    .filter((entry) => entry.status === "unchanged" && entry.skipped.length > 0)
    .map((entry) => (
      `${characterPrefix(entry, getClassEmoji)}: ${goldViewText("goldKeptAsIs", lang)}${goldSkippedTail(entry, lang)}`
    ));

  if (touched.length === 0) {
    if (keptLines.length === 0 && !missing) return null;
    return {
      kind: NoticeKind.INPUT,
      title: goldViewText("nothingChangedTitle", lang),
      description: clampDescription([...keptLines, missing]),
    };
  }

  if (receive?.kind === GOLD_RECEIVE_AUTO) {
    return {
      kind: NoticeKind.DONE,
      title: goldViewText("goldAutoSummaryTitle", lang, { n: touched.length }),
      description: clampDescription([
        ...touched.map((entry) => `${characterPrefix(entry, getClassEmoji)}: ${raidList(entry.kept, lang)}`),
        ignoredTicks ? goldViewText("goldIgnoredTicks", lang) : "",
        missing,
      ]),
    };
  }

  const ticked = [...(receive?.raidKeys || [])].sort(byRaidOrder);
  return {
    kind: NoticeKind.DONE,
    title: goldViewText("goldSummaryTitle", lang, { n: touched.length }),
    description: clampDescription([
      goldViewText("goldSetLine", lang, { raids: raidList(ticked, lang) }),
      ...touched.map((entry) => (
        `${characterPrefix(entry, getClassEmoji)}: ${goldChangeText(entry, lang)}${goldSkippedTail(entry, lang)}`
      )),
      ...keptLines,
      missing,
    ]),
  };
}

module.exports = {
  buildGoldReceiveSummaryNotice,
  buildModeSummaryNotice,
};
