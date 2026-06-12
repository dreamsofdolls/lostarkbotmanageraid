"use strict";

const {
  summarizeCharacterGold,
} = require("../../../../utils/raid/common/character");
const { parseCustomEmoji } = require("../../../../utils/discord/emoji");
const {
  goldReceiveIcon,
  localizedRaidLabel,
  rawGoldTotal,
} = require("../gold-formatting");
const { sameName } = require("./filters");

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

  return {
    buildGoldCharFilterRow,
    buildGoldToggleRow,
  };
}

module.exports = {
  createGoldToggleRows,
};
