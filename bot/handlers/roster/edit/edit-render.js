"use strict";

const { buildTogglePickerComponents } = require("../../../utils/raid/roster-picker");
const { t } = require("../../../services/i18n");
const {
  buildPickerClosedEmbed,
  formatClassIcon,
  formatSavedCharacterLine,
} = require("../picker/render");

const CHECK_ICON = "\u2705";
const UNCHECK_ICON = "\u2b1c";
const NEW_TAG = "\u{1f195}";
const STALE_TAG = "\u{1f4e6}";

function tagFor(character) {
  if (character.savedKey && !character.inBible) return STALE_TAG;
  if (!character.savedKey && character.inBible) return NEW_TAG;
  return "";
}

function createEditRosterRenderers({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  pickerMaxOptions,
  buttonsPerRow,
}) {
  function buildSelectionEmbed(session) {
    const lang = session.lang;
    const lines = session.chars.map((character, index) => {
      const cp = character.combatScore || "?";
      const tag = tagFor(character);
      const tagSuffix = tag ? ` \u00b7 ${tag}` : "";
      return `**${index + 1}.** ${character.charName} \u00b7 ${character.className} \u00b7 iLvl \`${character.itemLevel}\` \u00b7 CP \`${cp}\`${tagSuffix}`;
    });

    const desc = [
      t("raid-edit-roster.picker.rosterLine", lang, { accountName: session.accountName }),
      t("raid-edit-roster.picker.headerLine", lang),
      "",
      ...lines,
      "",
      t("raid-edit-roster.picker.selectingLine", lang, {
        selected: session.selectedIndices.size,
        total: session.chars.length,
      }),
    ];

    if (session.bibleError) {
      desc.push("");
      desc.push(
        t("raid-edit-roster.picker.bibleOffline", lang, {
          iconWarn: UI.icons.warn,
          error: session.bibleError,
        })
      );
    } else {
      desc.push(
        t("raid-edit-roster.picker.legend", lang, {
          iconInfo: UI.icons.info,
          newTag: NEW_TAG,
          staleTag: STALE_TAG,
        })
      );
    }

    if (session.excludedSavedCount > 0) {
      desc.push("");
      desc.push(
        t("raid-edit-roster.picker.excludedSaved", lang, {
          iconWarn: UI.icons.warn,
          cap: pickerMaxOptions,
          count: session.excludedSavedCount,
        })
      );
    }

    if (session.excludedBibleOnlyCount > 0) {
      desc.push("");
      desc.push(
        t("raid-edit-roster.picker.excludedBibleOnly", lang, {
          iconWarn: UI.icons.warn,
          count: session.excludedBibleOnlyCount,
          cap: pickerMaxOptions,
        })
      );
    }

    desc.push(t("raid-edit-roster.picker.footerHint", lang, { iconInfo: UI.icons.info }));

    return new EmbedBuilder()
      .setTitle(
        t("raid-edit-roster.picker.title", lang, {
          iconFolder: UI.icons.folder,
          accountName: session.accountName,
        })
      )
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: t("raid-edit-roster.picker.footerText", lang) });
  }

  function buildSelectionComponents(session) {
    return buildTogglePickerComponents({
      session,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      buttonsPerRow,
      customIdPrefix: "edit-roster",
      confirmLabel: t("raid-edit-roster.picker.confirmLabel", session.lang, {
        count: session.selectedIndices.size,
      }),
      confirmDisabled: session.selectedIndices.size === 0,
      cancelLabel: t("raid-edit-roster.picker.cancelLabel", session.lang),
      describeButton(character, index) {
        const isSelected = session.selectedIndices.has(index);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        const tag = tagFor(character);
        const tagSuffix = tag ? ` ${tag}` : "";
        return {
          selected: isSelected,
          label: `${marker} ${index + 1}. ${character.charName}${tagSuffix}`,
        };
      },
    });
  }

  function buildClosedEmbed(session, state) {
    return buildPickerClosedEmbed({
      EmbedBuilder,
      UI,
      t,
      keyPrefix: "raid-edit-roster",
      state,
      lang: session.lang,
      vars: { accountName: session.accountName },
      withFooter: true,
    });
  }

  function buildExpiredEmbed(session) {
    return buildClosedEmbed(session, "expired");
  }

  function buildCancelledEmbed(session) {
    return buildClosedEmbed(session, "cancelled");
  }

  /**
   * The card after an edit is saved: the roster as it is now with new
   * characters marked in place, and the removed ones struck in their own
   * field.
   * @param {object} session - the edit picker session
   * @param {{added: string[], removed: object[], kept: string[], finalChars: object[]}} summary
   *   - from persistEditedRoster; removed and finalChars are saved-character summaries
   * @returns {EmbedBuilder}
   */
  function buildSavedEmbed(session, summary) {
    const lang = session.lang;
    const { added, removed, kept, finalChars } = summary;
    const addedNames = new Set(added);
    const lines = finalChars.map((character) => formatSavedCharacterLine(
      character,
      addedNames.has(character.name) ? ` ${NEW_TAG}` : ""
    ));
    const boldNames = (names) => names.map((name) => `**${name}**`).join(", ");
    const changeParts = [
      added.length ? t("raid-edit-roster.saved.changes.added", lang, { names: boldNames(added) }) : "",
      removed.length
        ? t("raid-edit-roster.saved.changes.removed", lang, { names: boldNames(removed.map((character) => character.name)) })
        : "",
    ].filter(Boolean);
    const changeLine = changeParts.length
      ? changeParts.join(" \u00b7 ")
      : t(`raid-edit-roster.saved.changes.${kept.length ? "refreshed" : "none"}`, lang);

    const embed = new EmbedBuilder()
      .setTitle(t("raid-edit-roster.saved.title", lang, { iconFolder: UI.icons.folder }))
      .setDescription(
        [
          t("raid-edit-roster.saved.rosterLine", lang, { accountName: session.accountName }),
          changeLine,
        ].join("\n")
      )
      .addFields({
        name: t("raid-edit-roster.saved.charactersField", lang, { count: finalChars.length }),
        value:
          lines.join("\n").slice(0, 1024) ||
          t("raid-edit-roster.saved.charactersEmpty", lang),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: t("raid-edit-roster.saved.footerText", lang) })
      .setTimestamp();
    if (removed.length) {
      embed.addFields({
        name: t("raid-edit-roster.saved.removedField", lang),
        value: removed
          .map((character) => `${formatClassIcon(character.class)} ~~${character.name}~~ \u00b7 \`${character.itemLevel}\``)
          .join("\n")
          .slice(0, 1024),
        inline: false,
      });
    }
    return embed;
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
  NEW_TAG,
  STALE_TAG,
  createEditRosterRenderers,
};
