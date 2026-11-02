"use strict";

const { buildFlipPickerComponents } = require("../../../utils/raid/roster-picker");
const { t } = require("../../../services/i18n");
const { getClassEmoji } = require("../../../models/Class");
const { parseCustomEmoji } = require("../../../utils/discord/emoji");
const {
  buildPickerClosedEmbed,
  chunkLinesIntoFields,
  countRoles,
  formatClassIcon,
  formatPickerCloseTime,
  formatSavedCharacterLine,
  resolveRosterIcon,
  resolveSavedRosterIcon,
} = require("../picker/render");

const NEW_TAG = "\u{1f195}";

const NAME_FORMAT = Object.freeze({
  bold: (name) => `**${name}**`,
  plain: (name) => name,
  struck: (name) => `~~${name}~~`,
});

// How each picker state reads, keyed by `<saved|new>:<on|off>`. A saved
// character switched off is the one Save removes, so its line drops CP and
// says so; a Bible-only character keeps its "new on Bible" tail either way.
const EDIT_PICKER_STATE = Object.freeze({
  "saved:on": { glyph: "\u2705", name: NAME_FORMAT.bold, showCp: true, tailKey: null, optionKey: "optionKept", labelTag: "" },
  "saved:off": { glyph: "\u2796", name: NAME_FORMAT.struck, showCp: false, tailKey: "tailRemove", optionKey: "optionRemoving", labelTag: "" },
  "new:on": { glyph: NEW_TAG, name: NAME_FORMAT.bold, showCp: true, tailKey: "tailNew", optionKey: "optionAdding", labelTag: ` ${NEW_TAG}` },
  "new:off": { glyph: "\u2b1c", name: NAME_FORMAT.plain, showCp: true, tailKey: "tailNew", optionKey: "optionNotAdded", labelTag: ` ${NEW_TAG}` },
});

function editStateOf(session, character, index) {
  const origin = character.savedKey ? "saved" : "new";
  const toggle = session.selectedIndices.has(index) ? "on" : "off";
  return EDIT_PICKER_STATE[`${origin}:${toggle}`];
}

// A saved character Bible no longer lists. While the Bible fetch failed every
// saved character reads that way, and the \u26a0\ufe0f Bible line already says why.
function isStaleOnBible(session, character) {
  return Boolean(character.savedKey && !character.inBible && !session.bibleError);
}

/**
 * The roster icon and name an edit session's titles carry, iconed from the
 * roster's saved characters.
 * @param {{accountName: string, chars?: object[]}} session
 * @returns {{rosterIcon: string, rosterName: string}}
 */
function sessionTitleVars(session) {
  const candidates = (session.chars || [])
    .filter((c) => c.savedKey)
    .map((c) => ({ name: c.charName, className: c.className, combatScore: c.combatScore }));
  return {
    rosterIcon: resolveRosterIcon(session.accountName, candidates),
    rosterName: session.accountName,
  };
}

function createEditRosterRenderers({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UI,
  pickerMaxOptions,
}) {
  function formatPickerLine(session, character, index) {
    const lang = session.lang;
    const state = editStateOf(session, character, index);
    const cp = state.showCp ? ` \u00b7 CP \`${character.combatScore || "?"}\`` : "";
    const tail = state.tailKey ? t(`raid-edit-roster.picker.${state.tailKey}`, lang) : "";
    const stale = isStaleOnBible(session, character) ? t("raid-edit-roster.picker.tailStale", lang) : "";
    return `${state.glyph} **${index + 1}.** ${formatClassIcon(character.className)} ${state.name(character.charName)} \u00b7 \`${character.itemLevel}\`${cp}${tail}${stale}`;
  }

  // Warnings shown above the close line, each only when it applies.
  function buildWarningLines(session) {
    const lang = session.lang;
    const iconWarn = UI.icons.warn;
    return [
      session.bibleError
        ? t("raid-edit-roster.picker.bibleOffline", lang, { iconWarn, error: session.bibleError })
        : "",
      session.excludedSavedCount > 0
        ? t("raid-edit-roster.picker.excludedSaved", lang, { iconWarn, cap: pickerMaxOptions, count: session.excludedSavedCount })
        : "",
      session.excludedBibleOnlyCount > 0
        ? t("raid-edit-roster.picker.excludedBibleOnly", lang, { iconWarn, cap: pickerMaxOptions, count: session.excludedBibleOnlyCount })
        : "",
    ].filter(Boolean);
  }

  function buildSelectionEmbed(session) {
    const lang = session.lang;
    // Save keeps the saved characters beyond the picker cap, so they count
    // toward what the roster holds afterwards.
    const keptClasses = [
      ...session.chars.filter((_, index) => session.selectedIndices.has(index)).map((c) => c.className),
      ...(session.preservedSavedClasses || []),
    ];
    const { supports, dps } = countRoles(keptClasses);

    const desc = [
      t("raid-edit-roster.picker.summary", lang, {
        selected: session.selectedIndices.size + (session.preservedSavedKeys?.size || 0),
        supports,
        dps,
      }),
      ...session.chars.map((character, index) => formatPickerLine(session, character, index)),
      "",
      ...buildWarningLines(session),
      t("raid-edit-roster.picker.closeLine", lang, { closeTime: formatPickerCloseTime(session.expiresAt) }),
    ];

    return new EmbedBuilder()
      .setTitle(t("raid-edit-roster.picker.title", lang, sessionTitleVars(session)))
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.progress);
  }

  function buildSelectionComponents(session) {
    return buildFlipPickerComponents({
      session,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      ButtonBuilder,
      ButtonStyle,
      customIdPrefix: "edit-roster",
      placeholder: t("raid-edit-roster.picker.placeholder", session.lang),
      confirmLabel: t("raid-edit-roster.picker.confirmLabel", session.lang, {
        count: session.selectedIndices.size,
      }),
      confirmDisabled: session.selectedIndices.size === 0,
      cancelLabel: t("raid-edit-roster.picker.cancelLabel", session.lang),
      describeOption(character, index) {
        const state = editStateOf(session, character, index);
        return {
          label: `${index + 1}. ${character.charName}${state.labelTag}`,
          description: t(`raid-edit-roster.picker.${state.optionKey}`, session.lang),
          emoji: parseCustomEmoji(getClassEmoji(character.className)),
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
      titleVars: sessionTitleVars(session),
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

    const { supports, dps } = countRoles(finalChars.map((character) => character.class));
    const removedLines = removed
      .map((character) => `${formatClassIcon(character.class)} ~~${character.name}~~ \u00b7 \`${character.itemLevel}\``);

    return new EmbedBuilder()
      .setTitle(t("raid-edit-roster.saved.title", lang, {
        rosterIcon: resolveSavedRosterIcon(session.accountName, finalChars),
        rosterName: session.accountName,
      }))
      .setDescription([
        t("raid-edit-roster.saved.countLine", lang, { count: finalChars.length, supports, dps }),
        changeLine,
      ].join("\n"))
      .addFields(
        ...chunkLinesIntoFields(
          lines.length ? lines : [t("raid-edit-roster.saved.charactersEmpty", lang)],
          t("raid-edit-roster.saved.charactersField", lang, { count: finalChars.length })
        ),
        ...chunkLinesIntoFields(removedLines, t("raid-edit-roster.saved.removedField", lang))
      )
      .setColor(UI.colors.success);
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
  createEditRosterRenderers,
  sessionTitleVars,
};
