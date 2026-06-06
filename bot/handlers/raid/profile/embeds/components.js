"use strict";

const { t } = require("../../../../services/i18n");
const {
  aggregateCharacters,
  getEntryLabel,
} = require("../helpers/aggregate");
const {
  roleEmoji,
  roleLabel,
  score,
} = require("../helpers/display");

const MAX_SELECT_OPTIONS = 25;
const MAX_CHARACTER_SELECT_OPTIONS = MAX_SELECT_OPTIONS - 1;
const ROSTER_PAGE_SIZE = MAX_SELECT_OPTIONS - 1;

const EMOJI = {
  chart: "\u{1F4CA}",
  folder: "\u{1F4C1}",
  people: "\u{1F465}",
  prev: "◀️",
  next: "▶️",
};

function selectedProfileEntry(session) {
  return session.rosterIndex >= 0 ? session.entries[session.rosterIndex] : null;
}

function clampPage(page, totalItems, pageSize) {
  const maxPage = Math.max(0, Math.ceil(Math.max(0, totalItems) / pageSize) - 1);
  const n = Number(page) || 0;
  return Math.max(0, Math.min(maxPage, Math.floor(n)));
}

function selectOption(label, value, description, emoji, isDefault = false) {
  const option = {
    label: label.slice(0, 100) || "Unknown",
    value,
    default: isDefault,
  };
  if (description) option.description = description.slice(0, 100);
  if (emoji) option.emoji = emoji;
  return option;
}

function buildRosterOptions(session, lang) {
  const selectedEntry = selectedProfileEntry(session);
  const rosterPage = selectedEntry
    ? Math.floor(session.rosterIndex / ROSTER_PAGE_SIZE)
    : clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
  const rosterPageStart = rosterPage * ROSTER_PAGE_SIZE;

  return [
    selectOption(t("raidProfile.optOverall", lang), "overall", t("raidProfile.optOverallDesc", lang), EMOJI.chart, session.rosterIndex < 0),
    ...session.entries.slice(rosterPageStart, rosterPageStart + ROSTER_PAGE_SIZE).map((entry, offset) => {
      const index = rosterPageStart + offset;
      const agg = aggregateCharacters(entry.characters);
      return selectOption(
        getEntryLabel(entry),
        String(index),
        `${entry.isOwn ? "Own" : "Shared"} \u00B7 ${agg.charCount} char \u00B7 ${agg.logs} log`,
        entry.isOwn ? EMOJI.folder : EMOJI.people,
        session.rosterIndex === index
      );
    }),
  ];
}

function buildCharacterOptions(session, selectedEntry, lang) {
  if (!selectedEntry) {
    return [selectOption(t("raidProfile.optPickRosterFirst", lang), "disabled", t("raidProfile.optPickRosterFirstDesc", lang), EMOJI.folder, true)];
  }

  const charPageStart = session.charIndex >= 0
    ? Math.floor(session.charIndex / MAX_CHARACTER_SELECT_OPTIONS) * MAX_CHARACTER_SELECT_OPTIONS
    : 0;
  return [
    selectOption(t("raidProfile.optRosterOverview", lang), "overview", t("raidProfile.optRosterOverviewDesc", lang), EMOJI.folder, session.charIndex < 0),
    ...selectedEntry.characters.slice(charPageStart, charPageStart + MAX_CHARACTER_SELECT_OPTIONS).map((character, offset) => {
      const index = charPageStart + offset;
      return selectOption(
        character.name,
        String(index),
        `${roleLabel(character)} \u00B7 ${character.stats?.encounters || 0} scored \u00B7 score ${score(character.scores?.overall)}`,
        roleEmoji(character),
        session.charIndex === index
      );
    }),
  ];
}

function buildComponents(deps, session) {
  const {
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = deps;
  const sid = session.id;
  const lang = session.lang || "vi";
  const selectedEntry = selectedProfileEntry(session);
  const selectedChar = selectedEntry && session.charIndex >= 0
    ? selectedEntry.characters[session.charIndex]
    : null;

  const rosterRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:roster:${sid}`)
      .setPlaceholder(t("raidProfile.rosterPlaceholder", lang))
      .addOptions(buildRosterOptions(session, lang))
  );

  const charRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:char:${sid}`)
      .setPlaceholder(t("raidProfile.charPlaceholder", lang))
      .setDisabled(!selectedEntry)
      .addOptions(buildCharacterOptions(session, selectedEntry, lang))
  );

  const canPageChars = !!selectedEntry && selectedEntry.characters.length > 0;
  const canPageRosters = !selectedEntry && session.entries.length > ROSTER_PAGE_SIZE;
  const canPage = canPageChars || canPageRosters;
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`raid-profile:prev:${sid}`)
      .setEmoji(EMOJI.prev)
      .setLabel(t("raidProfile.btnPrev", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage),
    new ButtonBuilder()
      .setCustomId(`raid-profile:overview:${sid}`)
      .setEmoji(selectedChar ? EMOJI.folder : EMOJI.chart)
      .setLabel(selectedChar ? t("raidProfile.btnRosterOverview", lang) : t("raidProfile.btnOverall", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selectedEntry),
    new ButtonBuilder()
      .setCustomId(`raid-profile:next:${sid}`)
      .setEmoji(EMOJI.next)
      .setLabel(t("raidProfile.btnNext", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage)
  );

  return [rosterRow, charRow, buttonRow];
}

module.exports = {
  MAX_CHARACTER_SELECT_OPTIONS,
  MAX_SELECT_OPTIONS,
  ROSTER_PAGE_SIZE,
  buildCharacterOptions,
  buildComponents,
  buildRosterOptions,
  clampPage,
  selectedProfileEntry,
  selectOption,
};
