"use strict";

const {
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
  BUTTONS_PER_ROW,
  CHECK_ICON,
  UNCHECK_ICON,
} = require("./constants");
const { buildPickerClosedEmbed } = require("../picker/render");

function createGoldEarnerRenderers({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  t,
  buildTogglePickerComponents,
}) {
  function buildSelectionEmbed(session) {
    const lang = session.lang;
    const lines = session.chars.map((character, index) => {
      const isSelected = session.selectedIndices.has(index);
      const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
      return `${marker} **${index + 1}.** ${character.name} · ${character.class} · iLvl \`${character.itemLevel}\``;
    });

    const overflow = session.overflowCount > 0
      ? t("raid-gold-earner.picker.overflow", lang, {
          iconWarn: UI.icons.warn,
          count: session.overflowCount,
          cap: PICKER_MAX_OPTIONS,
        })
      : "";

    const desc = [
      t("raid-gold-earner.picker.rosterLine", lang, { accountName: session.accountName }),
      t("raid-gold-earner.picker.headerLine", lang, { cap: GOLD_EARNER_CAP_PER_ACCOUNT }),
      "",
      ...lines,
      "",
      t("raid-gold-earner.picker.selectingLine", lang, {
        selected: session.selectedIndices.size,
        cap: GOLD_EARNER_CAP_PER_ACCOUNT,
      }),
      t("raid-gold-earner.picker.footerHint", lang, {
        iconInfo: UI.icons.info,
        overflow,
      }),
    ];

    return new EmbedBuilder()
      .setTitle(
        t("raid-gold-earner.picker.title", lang, {
          checkIcon: CHECK_ICON,
          accountName: session.accountName,
        })
      )
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: t("raid-gold-earner.picker.footerText", lang) });
  }

  function buildSelectionComponents(session) {
    return buildTogglePickerComponents({
      session,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      buttonsPerRow: BUTTONS_PER_ROW,
      customIdPrefix: "gold-earner",
      confirmLabel: t("raid-gold-earner.picker.confirmLabel", session.lang, {
        count: session.selectedIndices.size,
      }),
      cancelLabel: t("raid-gold-earner.picker.cancelLabel", session.lang),
      describeButton(character, index) {
        const isSelected = session.selectedIndices.has(index);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        return {
          selected: isSelected,
          label: `${marker} ${index + 1}. ${character.name}`,
        };
      },
    });
  }

  function buildClosedEmbed(session, state) {
    return buildPickerClosedEmbed({
      EmbedBuilder,
      UI,
      t,
      keyPrefix: "raid-gold-earner",
      state,
      lang: session.lang,
      vars: { accountName: session.accountName },
    });
  }

  function buildExpiredEmbed(session) {
    return buildClosedEmbed(session, "expired");
  }

  function buildCancelledEmbed(session) {
    return buildClosedEmbed(session, "cancelled");
  }

  function buildSavedEmbed(session, savedNames) {
    const lang = session.lang;
    const previewSlice = savedNames.slice(0, GOLD_EARNER_CAP_PER_ACCOUNT);
    const value = previewSlice.length > 0
      ? previewSlice.map((name, index) => `${index + 1}. ${name}`).join("\n")
      : t("raid-gold-earner.saved.noneSelected", lang);
    return new EmbedBuilder()
      .setTitle(t("raid-gold-earner.saved.title", lang, { checkIcon: CHECK_ICON }))
      .setDescription(
        t("raid-gold-earner.saved.description", lang, {
          accountName: session.accountName,
          count: savedNames.length,
          cap: GOLD_EARNER_CAP_PER_ACCOUNT,
        })
      )
      .addFields({
        name: t("raid-gold-earner.saved.charactersField", lang, { count: savedNames.length }),
        value,
        inline: false,
      })
      .setColor(UI.colors.success)
      .setTimestamp();
  }

  return {
    buildSelectionEmbed,
    buildSelectionComponents,
    buildExpiredEmbed,
    buildCancelledEmbed,
    buildSavedEmbed,
  };
}

module.exports = {
  createGoldEarnerRenderers,
};
