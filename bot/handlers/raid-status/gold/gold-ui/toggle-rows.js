"use strict";

const {
  GOLD_RAID_CAP_PER_CHARACTER,
  summarizeCharacterGold,
} = require("../../../../utils/raid/common/character");
const {
  RAID_ORDER,
  RAID_REQUIREMENTS,
  areEquivalentRaidModes,
  compareRaidModeOrder,
  raidModeSortRank,
} = require("../../../../domain/raid-catalog");
const { parseCustomEmoji } = require("../../../../utils/discord/emoji");
const {
  getRaidLabel,
  getRaidSpecificModeLabel,
} = require("../../../../utils/raid/common/labels");
const {
  GOLD_RECEIVE_ICON,
  localizedRaidLabel,
  rawGoldTotal,
} = require("../gold-formatting");
const { sameCharacterName } = require("../../state/character-filter");
const { GOLD_RECEIVE_AUTO, MODE_CANCEL } = require("../gold-actions");

const DISCORD_SELECT_OPTION_CAP = 25;
const GOLD_AUTO_EMOJI = "\u{1F504}";

const MODE_DIRECTION_EMOJI = Object.freeze({
  cancel: "↩️",
  down: "⬇️",
  side: "↔️",
  up: "⬆️",
});

// First match wins: a manual choice outranks the auto outcome it overrides.
// The lock only marks roster-bound gold, as in the embed, so a raid excluded
// by hand reads as not receiving rather than locked.
const GOLD_STATUS_RULES = Object.freeze([
  { when: (raid) => raid.goldOverride === "include", icon: "receive", key: "toggleManualOn" },
  { when: (raid) => raid.goldDisabled, icon: "pending", key: "toggleManualOff" },
  { when: (raid) => raid.goldExcludedReason === "bound", icon: "lock", key: "toggleAutoBound" },
  { when: (raid) => raid.goldReceives, icon: "receive", key: "toggleAutoReceiving" },
  { when: () => true, icon: "pending", key: "toggleOutsideCap" },
]);

function resolveModeDirection({
  currentModeKey,
  currentRank,
  isCancel,
  raidKey,
  targetModeKey,
}) {
  if (isCancel) return "cancel";
  if (areEquivalentRaidModes(currentModeKey, targetModeKey)) return "side";
  return raidModeSortRank(raidKey, targetModeKey) > currentRank ? "up" : "down";
}

/**
 * Difficulty options for one character: every mode its item level allows,
 * minus the mode it already targets. While a change is queued, the current
 * mode becomes a cancel option.
 * @param {object[]} raids - the character's status raids
 * @param {number} itemLevel - the character's item level
 * @returns {object[]} options sorted by raid then mode order
 */
function computeGoldModeOptions(raids, itemLevel) {
  const out = [];
  for (const raid of raids || []) {
    const modes = RAID_REQUIREMENTS[raid.raidKey]?.modes || {};
    const currentModeKey = raid.modeKey;
    const effectiveTarget = raid.pendingModeKey || raid.modeKey;
    // A raid with clears this week defers the change to the next reset;
    // otherwise it lands immediately. Same value for every option of one raid.
    const deferred = Array.isArray(raid.completedGateKeys) && raid.completedGateKeys.length > 0;
    const currentRank = raidModeSortRank(raid.raidKey, currentModeKey);
    for (const [modeKey, mode] of Object.entries(modes)) {
      if (modeKey === effectiveTarget) continue;
      if (Number(itemLevel) < Number(mode.minItemLevel)) continue;
      const isCancel = !!raid.pendingModeKey && modeKey === currentModeKey;
      // Mode declaration order is difficulty order. Normal and Solo share one
      // tier, so switching between them is lateral rather than up/down.
      const direction = resolveModeDirection({
        currentModeKey,
        currentRank,
        isCancel,
        raidKey: raid.raidKey,
        targetModeKey: modeKey,
      });
      const goldTotal = Object.values(mode.gold || {})
        .reduce((sum, value) => sum + (Number(value) || 0), 0);
      out.push({
        raidKey: raid.raidKey,
        modeKey,
        currentModeKey,
        isCancel,
        direction,
        deferred,
        goldTotal,
        raidLabel: RAID_REQUIREMENTS[raid.raidKey]?.label || raid.raidName || raid.raidKey,
        modeLabel: mode.label,
        currentModeLabel: modes[currentModeKey]?.label || currentModeKey,
        value: `${raid.raidKey}::${isCancel ? MODE_CANCEL : modeKey}`,
      });
    }
  }
  return out.sort(compareRaidModeOrder);
}

function raidOf(entry, raidKey) {
  return (entry?.raids || []).find((raid) => raid.raidKey === raidKey) || null;
}

function hasClearsThisWeek(raid) {
  return Array.isArray(raid?.completedGateKeys) && raid.completedGateKeys.length > 0;
}

/**
 * Difficulty options for several characters. A (raid, mode) pair appears when
 * at least one selected character meets its item level and does not already
 * target it; a raid with any queued change also gets one cancel option.
 * @param {Array<{itemLevel: number, raids: object[]}>} entries - selected characters
 * @returns {Array<{raidKey: string, modeKey: string|null, isCancel: boolean, direction: string, minItemLevel: number, eligible: number, total: number, deferred: number, pending: number, value: string}>}
 */
function computeBulkGoldModeOptions(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const out = [];
  for (const raidKey of RAID_ORDER) {
    const holders = list
      .map((entry) => ({ entry, raid: raidOf(entry, raidKey) }))
      .filter((holder) => holder.raid);
    if (holders.length === 0) continue;

    for (const [modeKey, mode] of Object.entries(RAID_REQUIREMENTS[raidKey].modes || {})) {
      const minItemLevel = Number(mode.minItemLevel) || 0;
      const eligible = holders.filter(({ entry }) => (Number(entry.itemLevel) || 0) >= minItemLevel);
      const needing = eligible.filter(({ raid }) => (raid.pendingModeKey || raid.modeKey) !== modeKey);
      if (needing.length === 0) continue;
      // Direction is read against the hardest current mode among them.
      const hardest = eligible.reduce((best, holder) => (
        raidModeSortRank(raidKey, holder.raid.modeKey) > raidModeSortRank(raidKey, best.raid.modeKey)
          ? holder
          : best
      ));
      out.push({
        raidKey,
        modeKey,
        isCancel: false,
        direction: resolveModeDirection({
          currentModeKey: hardest.raid.modeKey,
          currentRank: raidModeSortRank(raidKey, hardest.raid.modeKey),
          isCancel: false,
          raidKey,
          targetModeKey: modeKey,
        }),
        minItemLevel,
        eligible: eligible.length,
        total,
        deferred: needing.filter(({ raid }) => hasClearsThisWeek(raid) && raid.modeKey !== modeKey).length,
        pending: 0,
        value: `${raidKey}::${modeKey}`,
      });
    }

    const pending = holders.filter(({ raid }) => raid.pendingModeKey).length;
    if (pending > 0) {
      out.push({
        raidKey,
        modeKey: null,
        isCancel: true,
        direction: "cancel",
        minItemLevel: 0,
        eligible: 0,
        total,
        deferred: 0,
        pending,
        value: `${raidKey}::${MODE_CANCEL}`,
      });
    }
  }
  // A cancel option has no modeKey, so it ranks last within its raid.
  return out.sort(compareRaidModeOrder).slice(0, DISCORD_SELECT_OPTION_CAP);
}

/**
 * Gold-set options for the selected characters, in catalog order, plus the
 * trailing auto option. A raid is pre-ticked when every selected character
 * receives gold from it.
 * @param {Array<{raids: object[]}>} entries - selected characters
 * @returns {Array<{raidKey: string|null, value: string, isAuto: boolean, receiving: number, has: number, total: number, default: boolean, raid: object|null}>}
 *   raid is the status raid when exactly one character is selected
 */
function computeGoldReceiveOptions(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const out = [];
  for (const raidKey of RAID_ORDER) {
    const raids = list.map((entry) => raidOf(entry, raidKey)).filter(Boolean);
    if (raids.length === 0) continue;
    const receiving = raids.filter((raid) => raid.goldReceives).length;
    out.push({
      raidKey,
      value: raidKey,
      isAuto: false,
      receiving,
      has: raids.length,
      total,
      default: receiving === total,
      raid: total === 1 ? raids[0] : null,
    });
  }
  out.push({
    raidKey: null,
    value: GOLD_RECEIVE_AUTO,
    isAuto: true,
    receiving: 0,
    has: 0,
    total,
    default: false,
    raid: null,
  });
  return out;
}

/**
 * Raid keys pre-ticked in the gold-set dropdown for these characters.
 * @param {Array<{raids: object[]}>} entries - selected characters
 * @returns {string[]} raid keys every entry receives gold from
 */
function goldReceiveDefaults(entries) {
  return computeGoldReceiveOptions(entries)
    .filter((option) => option.default)
    .map((option) => option.value);
}

function toOptionEmoji(icon) {
  return parseCustomEmoji(icon) || { name: icon };
}

function createGoldToggleRows({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UI,
  getClassEmoji,
  getCharacterName,
  truncateText,
  formatGold,
  getRaidsFor,
  lang,
  t,
  filterState,
}) {
  const {
    goldCharactersOnPage,
    resolveGoldCharSelection,
    selectedGoldCharacters,
  } = filterState;

  const GOLD_STATUS_ICONS = {
    receive: GOLD_RECEIVE_ICON,
    lock: UI.icons.lock,
    pending: UI.icons.pending,
  };

  function selectedEntries() {
    return selectedGoldCharacters().map((character) => ({
      name: getCharacterName(character),
      itemLevel: Number(character.itemLevel) || 0,
      raids: getRaidsFor(character),
    }));
  }

  function selectMenu({ customId, placeholder, disabled, options, maxValues }) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(truncateText(placeholder, 150))
        .setDisabled(disabled)
        .setMinValues(1)
        .setMaxValues(maxValues)
        .addOptions(options)
    );
  }

  function buildEmptyGoldRow({ customId, placeholder }) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setDisabled(true)
        .addOptions([{ label: "(empty)", value: "noop" }])
    );
  }

  function buildGoldCharsRow(disabled) {
    const candidates = goldCharactersOnPage().slice(0, DISCORD_SELECT_OPTION_CAP);
    if (candidates.length === 0) return null;
    const selected = resolveGoldCharSelection();
    const options = candidates.map((character) => {
      const name = getCharacterName(character);
      const totals = summarizeCharacterGold(getRaidsFor(character));
      const option = {
        label: truncateText(
          `${name} · ${Number(character.itemLevel) || 0} · ${formatGold(totals.earned)}/${formatGold(totals.total)}`,
          100
        ),
        value: name.slice(0, 100),
        default: selected.some((selectedName) => sameCharacterName(selectedName, name)),
      };
      const classEmojiObj = parseCustomEmoji(getClassEmoji(character.class || character.className));
      if (classEmojiObj) option.emoji = classEmojiObj;
      return option;
    });
    return selectMenu({
      customId: "status-gold:chars",
      placeholder: t("raid-status.goldView.charsPlaceholder", lang),
      disabled,
      options,
      maxValues: options.length,
    });
  }

  function singleReceiveOption(option) {
    const rule = GOLD_STATUS_RULES.find((candidate) => candidate.when(option.raid));
    const status = t(`raid-status.goldView.${rule.key}`, lang, {
      rank: option.raid.goldSlotRank || "?",
    });
    return {
      emoji: toOptionEmoji(GOLD_STATUS_ICONS[rule.icon]),
      label: truncateText(localizedRaidLabel(option.raid, lang), 100),
      description: truncateText(`${status} · ${formatGold(rawGoldTotal(option.raid))}`, 100),
      value: option.value,
      default: option.default,
    };
  }

  function bulkReceiveOption(option) {
    const hasTail = option.has < option.total
      ? t("raid-status.goldView.receiveOptionHasTail", lang, { has: option.has, total: option.total })
      : "";
    return {
      emoji: { name: option.receiving === option.total ? GOLD_RECEIVE_ICON : UI.icons.pending },
      label: truncateText(getRaidLabel(option.raidKey, lang) || option.raidKey, 100),
      description: truncateText(
        `${t("raid-status.goldView.receiveOptionMany", lang, { receiving: option.receiving, total: option.total })}${hasTail}`,
        100
      ),
      value: option.value,
      default: option.default,
    };
  }

  function autoReceiveOption(total) {
    return {
      emoji: { name: GOLD_AUTO_EMOJI },
      label: t("raid-status.goldView.receiveAutoLabel", lang),
      description: truncateText(total === 1
        ? t("raid-status.goldView.receiveAutoDescOne", lang, { cap: GOLD_RAID_CAP_PER_CHARACTER })
        : t("raid-status.goldView.receiveAutoDescMany", lang, { n: total }), 100),
      value: GOLD_RECEIVE_AUTO,
      default: false,
    };
  }

  function buildGoldReceiveRow(disabled) {
    const entries = selectedEntries();
    if (entries.length === 0) {
      return buildEmptyGoldRow({
        customId: "status-gold:receive",
        placeholder: t("raid-status.goldView.noGoldPlaceholder", lang),
      });
    }
    const single = entries.length === 1;
    const formatRaid = single ? singleReceiveOption : bulkReceiveOption;
    const options = computeGoldReceiveOptions(entries).map((option) => (
      option.isAuto ? autoReceiveOption(entries.length) : formatRaid(option)
    ));
    const placeholder = single
      ? t("raid-status.goldView.receivePlaceholderOne", lang, {
        name: entries[0].name,
        cap: GOLD_RAID_CAP_PER_CHARACTER,
      })
      : t("raid-status.goldView.receivePlaceholderMany", lang, {
        n: entries.length,
        cap: GOLD_RAID_CAP_PER_CHARACTER,
      });
    return selectMenu({
      customId: "status-gold:receive",
      placeholder,
      disabled,
      options,
      maxValues: Math.min(GOLD_RAID_CAP_PER_CHARACTER, options.length),
    });
  }

  function singleModeOption(option) {
    const raidLabel = getRaidLabel(option.raidKey, lang) || option.raidLabel;
    const targetLabel = getRaidSpecificModeLabel(option.raidKey, option.modeKey, lang)
      || option.modeLabel;
    // Directional emoji is the fast visual scan (up = harder, down = easier,
    // back = cancel a queued change); the grey description line carries the
    // current->target transition, timing, and gold so the bold label stays a
    // clean "Raid -> Mode".
    const emoji = MODE_DIRECTION_EMOJI[option.direction] || MODE_DIRECTION_EMOJI.cancel;
    const currentLabel = getRaidSpecificModeLabel(option.raidKey, option.currentModeKey, lang)
      || option.currentModeLabel;
    const timing = option.deferred
      ? t("raid-status.goldView.modeTimingReset", lang)
      : t("raid-status.goldView.modeTimingNow", lang);
    const description = option.isCancel
      ? t("raid-status.goldView.modeCancelDesc", lang)
      : t("raid-status.goldView.modeOptionDesc", lang, {
        current: currentLabel,
        target: targetLabel,
        timing,
        gold: formatGold(option.goldTotal),
      });
    return {
      emoji: { name: emoji },
      label: truncateText(`${raidLabel} → ${targetLabel}`, 100),
      description: truncateText(description, 100),
      value: option.value,
    };
  }

  function bulkModeOption(option) {
    const raidLabel = getRaidLabel(option.raidKey, lang) || option.raidKey;
    if (option.isCancel) {
      return {
        emoji: { name: MODE_DIRECTION_EMOJI.cancel },
        label: truncateText(t("raid-status.goldView.modeCancelLabel", lang, { raid: raidLabel }), 100),
        description: truncateText(t("raid-status.goldView.modeCancelDescMany", lang, { n: option.pending }), 100),
        value: option.value,
      };
    }
    const targetLabel = getRaidSpecificModeLabel(option.raidKey, option.modeKey, lang) || option.modeKey;
    const deferTail = option.deferred > 0
      ? t("raid-status.goldView.modeOptionDeferTail", lang, { n: option.deferred })
      : "";
    return {
      emoji: { name: MODE_DIRECTION_EMOJI[option.direction] || MODE_DIRECTION_EMOJI.up },
      label: truncateText(`${raidLabel} → ${targetLabel}`, 100),
      description: truncateText(`${t("raid-status.goldView.modeOptionDescMany", lang, {
        ilvl: option.minItemLevel,
        eligible: option.eligible,
        total: option.total,
      })}${deferTail}`, 100),
      value: option.value,
    };
  }

  function buildGoldModeRow(disabled) {
    const entries = selectedEntries();
    if (entries.length === 0) return null;
    const single = entries.length === 1;
    const options = single
      ? computeGoldModeOptions(entries[0].raids, entries[0].itemLevel)
        .slice(0, DISCORD_SELECT_OPTION_CAP)
        .map(singleModeOption)
      : computeBulkGoldModeOptions(entries).map(bulkModeOption);
    if (options.length === 0) return null;
    const placeholder = single
      ? t("raid-status.goldView.modePlaceholder", lang, { name: entries[0].name })
      : t("raid-status.goldView.modePlaceholderMany", lang, { n: entries.length });
    return selectMenu({
      customId: "status-gold:mode",
      placeholder,
      disabled,
      options,
      maxValues: options.length,
    });
  }

  return {
    buildGoldCharsRow,
    buildGoldModeRow,
    buildGoldReceiveRow,
  };
}

module.exports = {
  createGoldToggleRows,
  computeBulkGoldModeOptions,
  computeGoldModeOptions,
  computeGoldReceiveOptions,
  goldReceiveDefaults,
};
