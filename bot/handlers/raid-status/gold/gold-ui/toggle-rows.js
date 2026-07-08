"use strict";

const {
  summarizeCharacterGold,
} = require("../../../../utils/raid/common/character");
const { RAID_REQUIREMENTS, compareRaidModeOrder } = require("../../../../models/Raid");
const { parseCustomEmoji } = require("../../../../utils/discord/emoji");
const {
  getRaidLabel,
  getRaidSpecificModeLabel,
} = require("../../../../utils/raid/common/labels");
const {
  goldReceiveIcon,
  localizedRaidLabel,
  rawGoldTotal,
} = require("../gold-formatting");
const { sameName } = require("./filters");

function computeGoldModeOptions(activeName, raids, itemLevel) {
  const out = [];
  for (const raid of raids || []) {
    const modes = RAID_REQUIREMENTS[raid.raidKey]?.modes || {};
    const effectiveTarget = raid.pendingModeKey || raid.modeKey;
    for (const [modeKey, mode] of Object.entries(modes)) {
      if (modeKey === effectiveTarget) continue;
      if (Number(itemLevel) < Number(mode.minItemLevel)) continue;
      out.push({
        raidKey: raid.raidKey,
        modeKey,
        isCancel: !!raid.pendingModeKey && modeKey === raid.modeKey,
        raidLabel: RAID_REQUIREMENTS[raid.raidKey]?.label || raid.raidName || raid.raidKey,
        modeLabel: mode.label,
        value: `${activeName}::${raid.raidKey}::${modeKey}`.slice(0, 100),
      });
    }
  }
  return out.sort(compareRaidModeOrder);
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
    activeGoldCharacter,
    goldCharactersOnPage,
    resolveGoldCharFilter,
  } = filterState;

  function buildEmptyGoldToggleRow({ placeholder }) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:toggle")
        .setPlaceholder(placeholder)
        .setDisabled(true)
        .addOptions([{ label: "(empty)", value: "noop" }])
    );
  }

  function buildGoldCharFilterRow(disabled) {
    const candidates = goldCharactersOnPage();
    if (candidates.length === 0) return null;
    const activeName = resolveGoldCharFilter();
    const options = candidates.slice(0, 25).map((character) => {
      const name = getCharacterName(character);
      const raids = getRaidsFor(character);
      const totals = summarizeCharacterGold(raids);
      const option = {
        label: truncateText(
          `${name} \u00B7 ${Number(character.itemLevel) || 0} \u00B7 ${formatGold(totals.earned)}/${formatGold(totals.total)}`,
          100
        ),
        value: name.slice(0, 100),
        default: sameName(name, activeName),
      };
      const classEmojiObj = parseCustomEmoji(
        getClassEmoji(character.class || character.className)
      );
      if (classEmojiObj) option.emoji = classEmojiObj;
      return option;
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:char-filter")
        .setPlaceholder(t("raid-status.goldView.charFilterPlaceholder", lang))
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  function buildGoldToggleOption(activeName, raid) {
    const label = localizedRaidLabel(raid, lang);
    let icon = raid.goldReceives ? goldReceiveIcon(raid, UI) : UI.icons.pending;
    let status;
    if (raid.goldOverride === "include") {
      icon = goldReceiveIcon(raid, UI);
      status = t("raid-status.goldView.toggleManualOn", lang);
    } else if (raid.goldDisabled) {
      icon = UI.icons.lock;
      status = t("raid-status.goldView.toggleManualOff", lang);
    } else if (raid.goldExcludedReason === "bound") {
      icon = UI.icons.lock;
      status = t("raid-status.goldView.toggleAutoBound", lang);
    } else if (raid.goldReceives) {
      status = t("raid-status.goldView.toggleAutoReceiving", lang, {
        rank: raid.goldSlotRank || "?",
      });
    } else {
      status = t("raid-status.goldView.toggleOutsideCap", lang);
    }
    return {
      label: truncateText(`${icon} ${label} \u00B7 ${status}`, 100),
      description: truncateText(formatGold(rawGoldTotal(raid)), 100),
      value: `${activeName}::${raid.raidKey}`.slice(0, 100),
    };
  }

  function buildGoldToggleRow(disabled) {
    const character = activeGoldCharacter();
    if (!character) {
      return buildEmptyGoldToggleRow({
        placeholder: t("raid-status.goldView.noGoldPlaceholder", lang),
      });
    }

    const activeName = getCharacterName(character);
    const raids = getRaidsFor(character);
    if (raids.length === 0) {
      return buildEmptyGoldToggleRow({
        placeholder: t("raid-status.goldView.charNoRaidPlaceholder", lang, {
          name: activeName,
        }),
      });
    }

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:toggle")
        .setPlaceholder(t("raid-status.goldView.togglePlaceholder", lang, {
          name: activeName,
        }))
        .setDisabled(disabled)
        .addOptions(raids.slice(0, 25).map((raid) => buildGoldToggleOption(activeName, raid)))
    );
  }

  function buildGoldModeRow(disabled) {
    const character = activeGoldCharacter();
    if (!character) return null;
    const activeName = getCharacterName(character);
    const raids = getRaidsFor(character);
    const options = computeGoldModeOptions(
      activeName,
      raids,
      Number(character.itemLevel) || 0
    ).slice(0, 25);
    if (options.length === 0) return null;

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:mode")
        .setPlaceholder(t("raid-status.goldView.modePlaceholder", lang, {
          name: activeName,
        }))
        .setDisabled(disabled)
        .addOptions(options.map((option) => {
          const raidLabel = getRaidLabel(option.raidKey, lang) || option.raidLabel;
          const modeLabel = getRaidSpecificModeLabel(option.raidKey, option.modeKey, lang)
            || option.modeLabel;
          return {
            label: truncateText(
              option.isCancel
                ? t("raid-status.goldView.modeCancelOption", lang, {
                  raid: raidLabel,
                  mode: modeLabel,
                })
                : `${raidLabel} → ${modeLabel}`,
              100
            ),
            value: option.value,
          };
        }))
    );
  }

  return {
    buildGoldCharFilterRow,
    buildGoldModeRow,
    buildGoldToggleRow,
  };
}

module.exports = {
  createGoldToggleRows,
  computeGoldModeOptions,
};
