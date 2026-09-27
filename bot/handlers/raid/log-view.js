"use strict";

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { t } = require("../../services/i18n");
const { tabsForPlayer } = require("../../services/raid-log/tabs");

const PAGE_SIZE = 22; // Leave room for previous, next and loading older logs.
const timestamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function buildSummaryFields(summary, lang) {
  const text = String(summary || "");
  const duration = text.match(/Duration:\s*([\d:]+)(?:\s*(\+[\d:]+))?/);
  const values = {
    duration: duration?.slice(1).filter(Boolean).join(" "),
    totalDamage: text.match(/Total DMG:\s*([\d,]+)/)?.[1],
    totalDps: text.match(/Total DPS:\s*([\d,]+)/)?.[1],
  };
  return Object.entries(values).filter(([, value]) => value)
    .map(([key, value]) => ({ name: t(`raid-log.fields.${key}`, lang), value, inline: true }));
}

function panelChoices(state) {
  const logs = state.catalog.logs;
  const raids = [...new Map(logs.map(log => [log.raidKey, log.raidLabel])).entries()]
    .map(([value, label]) => ({ label: label.slice(0, 100), value, default: value === state.selected.raidKey }));
  const raidLogs = logs.filter(log => log.raidKey === state.selected.raidKey).map(log => ({
    label: log.timestamp ? `${log.gate} · ${log.difficulty} · ${timestamp.format(log.timestamp)}`.slice(0, 100) : log.raidLabel.slice(0,100),
    value: log.id, default: log.id === state.selected.id,
    description: `${log.duration ? `${Math.floor(log.duration / 60_000)}:${String(Math.floor(log.duration / 1000) % 60).padStart(2,"0")} · ` : ""}${log.id}`.slice(0,100),
  }));
  return { raids, logs: raidLogs };
}

function pagedChoices(choices, page, hasMore, lang) {
  const result = choices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (page > 0) result.push({ label: t("common.pagination.previous", lang), value: "__prev" });
  if ((page + 1) * PAGE_SIZE < choices.length) result.push({ label: t("common.pagination.next", lang), value: "__next" });
  if (hasMore) result.push({ label: t("raid-log.controls.loadMore", lang), value: "__more" });
  return result;
}

function buildLogComponents(state, disabled = false) {
  const id = action => `raid-log:${state.id}:${state.revision}:${action}`;
  const { raids, logs } = panelChoices(state);
  const tabs = tabsForPlayer(state.player, state.result);
  const tabKeys = Object.keys(tabs);
  const tabIndex = tabKeys.indexOf(state.tab);
  const button = (action, label, inactive = disabled, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(id(action)).setLabel(label).setStyle(style).setDisabled(inactive);
  const select = (action, placeholder, options) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(id(action)).setPlaceholder(placeholder.slice(0, 150))
      .setDisabled(disabled).addOptions(options),
  );
  return [
    new ActionRowBuilder().addComponents(
      button("bracketed", state.bracketed ? "Bracketed: ON" : "Bracketed: OFF · Normalized", disabled,
        state.bracketed ? ButtonStyle.Primary : ButtonStyle.Secondary),
      button("reset", t("raid-log.controls.reset", state.lang)),
      button("refresh", t("raid-log.controls.refresh", state.lang)),
    ),
    new ActionRowBuilder().addComponents(
      button("tab_prev", "◀", disabled || tabIndex === 0),
      button("tab_label", `${tabs[state.tab]} · ${tabIndex + 1}/${tabKeys.length}`, true),
      button("tab_next", "▶", disabled || tabIndex === tabKeys.length - 1),
    ),
    select("player", t("raid-log.controls.player", state.lang), [
      { label: t("raid-log.controls.team", state.lang), value: "__team", default: !state.player },
      ...(state.result.players || []).map((player, index) => ({
        label: `${index + 1}. ${player.label}`.slice(0, 100), value: player.id, default: player.id === state.player?.id,
        description: [`Party ${player.party}`, player.className].filter(Boolean).join(" · ").slice(0, 100),
      })),
    ]),
    select("raid", `2 · ${state.selected.raidLabel}`, pagedChoices(raids, state.raidPage, state.catalog.hasMore, state.lang)),
    select("log", `3 · ${t("raid-log.controls.log", state.lang)}`, pagedChoices(logs, state.logPage, false, state.lang)),
  ];
}

function buildLogEmbed(state, result, { EmbedBuilder, UI }) {
  const tabs = tabsForPlayer(state.player);
  const description = [t("raid-log.character", state.lang, { character: state.catalog.profile.name })];
  description.push(t("raid-log.description", state.lang, {
    players: result.playerCount, parties: result.partyCount, view: tabs[state.tab],
  }));
  if (state.player) description.push(t("raid-log.controls.selectedPlayer", state.lang, { player: state.player.label }));
  if (result.links?.length) description.push(result.links.map(link => `[${link.title}](${link.url})`).join(" · "));
  description.push(`**${state.bracketed ? "Bracketed" : "Normalized"}**`);
  description.push(t(`raid-log.controls.${state.catalog.hasMore ? "history" : "historyEnd"}`, state.lang, { count: state.catalog.logs.length }));
  return new EmbedBuilder().setColor(UI.colors.progress).setTitle(`🧪 TEST · ${result.title}`.slice(0, 256))
    .setURL(result.url).setDescription(description.join("\n"))
    .addFields({ name: t("raid-log.details", state.lang), value: result.header.replace(/\n{2,}/g, "\n").slice(0,1024) })
    .addFields(buildSummaryFields(result.summary, state.lang))
    .setImage(`attachment://${result.filename}`).setFooter({ text: t("raid-log.controls.footer", state.lang) });
}

function buildLogEmbeds(state, result, builders) {
  const first = buildLogEmbed(state, result, builders);
  const second = result.images?.[1];
  if (!second) return [first];
  first.setFooter({ text: t("raid-log.controls.imagePart", state.lang, { part: 1 }) });
  return [first, new builders.EmbedBuilder().setColor(builders.UI.colors.progress)
    .setTitle(`${state.player.label} · ${tabsForPlayer(state.player)[state.tab]}`.slice(0, 256))
    .setImage(`attachment://${second.filename}`)
    .setFooter({ text: t("raid-log.controls.imagePart", state.lang, { part: 2 }) })];
}

module.exports = { buildSummaryFields, buildLogComponents, buildLogEmbed, buildLogEmbeds, panelChoices, pagedChoices, PAGE_SIZE };
