"use strict";

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const { t } = require("../../services/i18n");
const { normalizeCharacterName } = require("../../services/raid-log/source");
const { getCharacterName, getCharacterClass } = require("../../utils/raid/common/shared");
const { pagedChoices, PAGE_SIZE } = require("./log-view");

function rosterChoices(accounts = []) {
  return accounts.flatMap(account => (account.characters || []).flatMap(character => {
    const name = String(getCharacterName(character)).trim();
    if (!name) return [];
    return [{
      name,
      key: JSON.stringify([account.accountName, normalizeCharacterName(name)]),
      label: name.slice(0, 100),
      description: [account.accountName, getCharacterClass(character), character.itemLevel].filter(Boolean).join(" · ").slice(0, 100),
    }];
  })).map((choice, index) => ({ ...choice, value: String(index) }));
}

function pickerOptions(state) {
  const choices = state.choices.map(({ label, description, value }) => ({ label, description, value }));
  return pagedChoices(choices, state.page, state.lang);
}

function buildLogPicker(state, { EmbedBuilder, UI }) {
  const key = state.rosterUnavailable ? "unavailable" : state.choices.length ? "withRoster" : "withoutRoster";
  const description = [
    t("raid-log.picker.description", state.lang, { owner: `<@${state.ownerId}>` }),
    t(`raid-log.picker.${key}`, state.lang, { count: state.choices.length }),
    t("raid-log.picker.defaults", state.lang),
  ];
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid-log:${state.id}:${state.revision}:search`)
      .setLabel(t("raid-log.picker.search", state.lang)).setStyle(ButtonStyle.Primary),
  )];
  if (state.choices.length) components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`raid-log:${state.id}:${state.revision}:character`)
      .setPlaceholder(t("raid-log.picker.select", state.lang, {
        page: state.page + 1, pages: Math.ceil(state.choices.length / PAGE_SIZE),
      })).addOptions(pickerOptions(state)),
  ));
  return {
    content: null,
    embeds: [new EmbedBuilder().setColor(UI.colors.progress).setTitle(t("raid-log.picker.title", state.lang))
      .setDescription(description.join("\n\n")).setFooter({ text: t("raid-log.picker.footer", state.lang) })],
    components, allowedMentions: { parse: [] },
  };
}

function buildLogSearchModal(state) {
  return new ModalBuilder().setCustomId(`raid-log:${state.id}:${state.revision}:submit`)
    .setTitle(t("raid-log.picker.search", state.lang)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("character").setLabel(t("raid-log.picker.name", state.lang))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)),
    );
}

module.exports = { rosterChoices, pickerOptions, buildLogPicker, buildLogSearchModal };
