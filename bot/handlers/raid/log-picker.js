"use strict";

/**
 * bot/handlers/raid/log-picker.js
 * The /raid-log opening card: search by name, or a menu of the caller's own
 * saved characters, and the search box.
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const { t } = require("../../services/i18n");
const { getClassEmoji } = require("../../models/Class");
const { parseCustomEmoji } = require("../../utils/discord/emoji");
const { truncateSelectText } = require("../../utils/discord/select-options");
const { normalizeCharacterName } = require("../../services/raid-log/source");
const { getCharacterName, getCharacterClass } = require("../../utils/raid/common/shared");
const { pagedChoices, PAGE_SIZE } = require("./log-view");

/**
 * @param {object[]} [accounts] the caller's saved accounts
 * @returns {object[]} one choice per named character; `value` is its index, `key` survives roster reordering
 */
function rosterChoices(accounts = []) {
  return accounts.flatMap(account => (account.characters || []).flatMap(character => {
    const name = String(getCharacterName(character)).trim();
    if (!name) return [];
    return [{
      name, key: JSON.stringify([account.accountName, normalizeCharacterName(name)]),
      roster: account.accountName, className: getCharacterClass(character), itemLevel: character.itemLevel,
    }];
  })).map((choice, index) => ({ ...choice, value: String(index) }));
}

/**
 * @param {object} state picker session
 * @returns {object[]} the menu options of the current page
 */
function pickerOptions(state) {
  const options = state.choices.map(choice => {
    const emoji = parseCustomEmoji(getClassEmoji(choice.className));
    return {
      label: truncateSelectText(choice.name, 100), value: choice.value,
      description: truncateSelectText(t("raid-log.picker.rosterOption", state.lang, { roster: choice.roster, itemLevel: choice.itemLevel }), 100),
      ...(emoji ? { emoji } : {}),
    };
  });
  return pagedChoices(options, state.page, state.lang);
}

/**
 * @param {object} state picker session
 * @param {{ EmbedBuilder: Function, UI: object }} builders
 * @returns {object} message payload
 */
function buildLogPicker(state, { EmbedBuilder, UI }) {
  const id = action => `raid-log:${state.id}:${state.revision}:${action}`;
  const key = state.rosterUnavailable ? "unavailable" : state.choices.length ? "withRoster" : "withoutRoster";
  const buttons = [new ButtonBuilder().setCustomId(id("search")).setEmoji("🔎")
    .setLabel(t("raid-log.picker.search", state.lang)).setStyle(ButtonStyle.Primary)];
  // Recent logs read the saved roster, so the button needs saved characters.
  if (state.choices.length) {
    buttons.push(new ButtonBuilder().setCustomId(id("recent_open")).setEmoji("🕘")
      .setLabel(t("raid-log.picker.recent", state.lang)).setStyle(ButtonStyle.Secondary));
  }
  const components = [new ActionRowBuilder().addComponents(...buttons)];
  if (state.choices.length) {
    const pages = Math.ceil(state.choices.length / PAGE_SIZE);
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id("character"))
      .setPlaceholder(pages > 1 ? t("raid-log.picker.selectPage", state.lang, { page: state.page + 1, pages }) : t("raid-log.picker.select", state.lang))
      .addOptions(pickerOptions(state))));
  }
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(UI.colors.neutral).setTitle(`📜 ${t("raid-log.picker.title", state.lang)}`)
      .setDescription(`${t(`raid-log.picker.${key}`, state.lang)}\n-# ${t("raid-log.picker.hint", state.lang)}`)],
    components, allowedMentions: { parse: [] },
  };
}

/**
 * @param {object} state picker session
 * @returns {ModalBuilder}
 */
function buildLogSearchModal(state) {
  return new ModalBuilder().setCustomId(`raid-log:${state.id}:${state.revision}:submit`)
    .setTitle(t("raid-log.picker.modalTitle", state.lang)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("character").setLabel(t("raid-log.picker.name", state.lang))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)),
    );
}

module.exports = { rosterChoices, pickerOptions, buildLogPicker, buildLogSearchModal };
