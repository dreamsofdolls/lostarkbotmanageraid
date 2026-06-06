"use strict";

const { buildTogglePickerComponents } = require("../../../utils/raid/roster-picker");
const { t } = require("../../../services/i18n");

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
      confirmLabel: `Confirm (${session.selectedIndices.size})`,
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

  function buildExpiredEmbed(session) {
    const lang = session.lang;
    return new EmbedBuilder()
      .setTitle(t("raid-edit-roster.expired.title", lang, { iconWarn: UI.icons.warn }))
      .setDescription(
        t("raid-edit-roster.expired.description", lang, {
          accountName: session.accountName,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-edit-roster.expired.footerText", lang) });
  }

  function buildCancelledEmbed(session) {
    const lang = session.lang;
    return new EmbedBuilder()
      .setTitle(t("raid-edit-roster.cancelled.title", lang, { iconInfo: UI.icons.info }))
      .setDescription(
        t("raid-edit-roster.cancelled.description", lang, {
          accountName: session.accountName,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-edit-roster.cancelled.footerText", lang) });
  }

  function buildSavedEmbed(session, summary) {
    const lang = session.lang;
    const { added, removed, kept, finalChars } = summary;
    const lines = finalChars.map(
      (character, index) =>
        `${index + 1}. ${character.name} \u00b7 ${character.class} \u00b7 \`${character.itemLevel}\` \u00b7 \`${character.combatScore || "?"}\``
    );
    const diffParts = [];

    if (added.length) {
      diffParts.push(
        t("raid-edit-roster.saved.diffAdded", lang, {
          count: added.length,
          names: added.join(", "),
        })
      );
    }

    if (removed.length) {
      diffParts.push(
        t("raid-edit-roster.saved.diffRemoved", lang, {
          count: removed.length,
          names: removed.join(", "),
        })
      );
    }

    if (kept.length && !added.length && !removed.length) {
      diffParts.push(
        t("raid-edit-roster.saved.diffUnchanged", lang, { count: kept.length })
      );
    }

    const diffLine = diffParts.length
      ? diffParts.join(" \u00b7 ")
      : t("raid-edit-roster.saved.diffNoChange", lang);

    return new EmbedBuilder()
      .setTitle(t("raid-edit-roster.saved.title", lang, { iconFolder: UI.icons.folder }))
      .setDescription(
        [
          t("raid-edit-roster.saved.rosterLine", lang, { accountName: session.accountName }),
          t("raid-edit-roster.saved.diffLine", lang, { diff: diffLine }),
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
  CHECK_ICON,
  NEW_TAG,
  STALE_TAG,
  UNCHECK_ICON,
  createEditRosterRenderers,
  tagFor,
};
