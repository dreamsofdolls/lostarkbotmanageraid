"use strict";

/**
 * bot/handlers/raid/log-view.js
 * The /raid-log log-book card (MVP and score fields, the raid's latest
 * logs, the capture) and its controls.
 */

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { t } = require("../../services/i18n");
const { getClassEmoji, isSupportClass } = require("../../models/Class");
const { tabsForPlayer } = require("../../services/raid-log/tabs");
const { pickHighlights } = require("../../services/raid-log/highlights");
const { parseTier } = require("../../services/raid-log/parse-tiers");
const { formatCompact, percentOf, formatPercent, formatShare, formatClock, formatWhen } = require("../../services/raid-log/format");
const { parseCustomEmoji } = require("../../utils/discord/emoji");
const { truncateSelectText } = require("../../utils/discord/select-options");
const { normalizeCharacterName } = require("../../services/raid-log/source");

// ─── Card ───

const HISTORY_SIZE = 5;
const badgeText = badge => `${parseTier(badge).emoji} ${badge}`;
const field = (emoji, key, value, lang) => ({ name: `${emoji} ${t(`raid-log.fields.${key}`, lang)}`, value, inline: true });

/**
 * The percentile a log is judged by: a support's rContribution, otherwise the
 * dealer percentile of the mode on screen. Bible has no normalized figure for supports.
 * @param {object} entry catalog log
 * @param {boolean} support whether the looked-up character plays a support
 * @param {boolean} bracketed
 * @returns {number|null} whole percent
 */
function headlinePercent(entry, support, bracketed) {
  return percentOf(support ? entry.contributionPercentile : bracketed ? entry.percentile : entry.normalizedPercentile);
}

// Bible labels a row "<gear score> <name>"; anonymous rows such as "Slayer #1" have none.
function splitLabel(label) {
  const [, itemLevel = "", name = label] = /^(\d{4}(?:\.\d+)?) (.+)$/.exec(label) || [];
  return { itemLevel, name };
}

// One MVP field per pick. The chip reads "-" while the pick lacks `figure`;
// without a pick at all the field shows `empty` ([values key, chip]) or a bare "-".
const HIGHLIGHT_FIELDS = [
  { emoji: "👑", key: "mvpDamage", pick: "damage", figure: "share", chip: pick => `${pick.share}% D%` },
  { emoji: "📈", key: "scoreDealer", pick: "dealerScore", figure: "badge",
    chip: pick => `${badgeText(pick.badge)} · ${formatCompact(pick.ndps)} nDPS` },
  { emoji: "🎯", key: "mvpCounter", pick: "counter", figure: "counters", empty: ["noCounter", "0"],
    chip: (pick, lang) => [t("raid-log.values.counter", lang, { count: pick.counters }),
      ...(pick.tied ? [`${formatCompact(pick.stagger)} STAG`] : [])].join(" · ") },
  { emoji: "✨", key: "mvpSupport", pick: "support", figure: "share", empty: ["noSupport", "-"], chip: pick => `${pick.share}% bD%` },
  { emoji: "🤝", key: "supportContribution", pick: "supportContribution", figure: "badge", empty: ["noSupport", "-"],
    chip: pick => [badgeText(pick.badge), ...(pick.contribution === null ? [] : [`${pick.contribution}% rCon`])].join(" · ") },
  { emoji: "⏱️", key: "supportUptime", pick: "supportUptime", figure: "badge", empty: ["noSupport", "-"],
    chip: pick => badgeText(pick.badge) },
];

// Custom emoji do not render inside code spans, so the name sits above its chip.
function highlightFields(players, bracketed, lang) {
  const picks = pickHighlights(players, bracketed);
  const person = (pick, chip) => `${[getClassEmoji(pick.player.className), `**${splitLabel(pick.player.label).name}**`]
    .filter(Boolean).join(" ")}\n\`${chip}\``;
  return HIGHLIGHT_FIELDS.map(({ emoji, key, pick: pickKey, figure, empty, chip }) => {
    const pick = picks[pickKey];
    const value = pick ? person(pick, pick[figure] === null ? "-" : chip(pick, lang))
      : empty ? `${t(`raid-log.values.${empty[0]}`, lang)}\n\`${empty[1]}\`` : "`-`";
    return field(emoji, key, value, lang);
  });
}

// The figures after a log's headline percent, shared by the history and the log menu.
function logFigures(entry, support, lang) {
  const figures = support
    ? [`${formatPercent(percentOf(entry.percentile))} ${t("raid-log.values.uptime", lang)}`, `${formatShare(entry.rContribution)} rCon`]
    : [`${formatCompact(entry.dps)} DPS`, `${formatCompact(entry.ndps)} nDPS`];
  return [...figures, `⏱ ${formatClock(entry.duration)}`, ...(entry.isDead ? ["💀"] : []), ...(entry.isBus ? ["🚌"] : [])];
}

/**
 * @param {{ catalog: object, selected: object }} state
 * @returns {object[]} the catalog's logs of the open log's raid, newest first
 */
function openRaidLogs({ catalog, selected }) {
  return catalog.logs.filter(entry => entry.raidKey === selected.raidKey);
}

function historyField(state, support) {
  const shown = openRaidLogs(state).slice(0, HISTORY_SIZE);
  // The open log stays on the card even when it is older than the newest five.
  if (!shown.some(entry => entry.id === state.selected.id)) shown[shown.length - 1] = state.selected;
  const lines = shown.map(entry => {
    const percent = headlinePercent(entry, support, state.bracketed);
    const line = [`${parseTier(percent).emoji} ${entry.gate || entry.raidLabel}`, formatWhen(entry.timestamp),
      `**${formatPercent(percent)}**`, ...logFigures(entry, support, state.lang)].join(" · ");
    return entry.id === state.selected.id ? `▶ ${line}` : `-# ${line}`;
  });
  return { name: `📜 ${t("raid-log.panel.history", state.lang, { count: shown.length })}`, value: lines.join("\n") };
}

/**
 * @param {object} state panel session (catalog, selected log, player, bracketed, lang)
 * @param {object} result capture metadata: players, url, links, images[].filename
 * @param {{ EmbedBuilder: Function, UI: object }} builders
 * @returns {import("discord.js").EmbedBuilder[]} the card, plus an image-only embed for a player's lower image
 */
function buildLogEmbeds(state, result, { EmbedBuilder, UI }) {
  const support = isSupportClass(state.catalog.profile.className);
  const color = parseTier(headlinePercent(state.selected, support, state.bracketed)).color ?? UI.colors.neutral;
  const card = new EmbedBuilder().setColor(color).setURL(result.url)
    .setTitle(`📜 ${t("raid-log.panel.title", state.lang, { raid: state.selected.raidLabel, character: state.catalog.profile.name })}`)
    .addFields(...highlightFields(result.players, state.bracketed, state.lang), historyField(state, support))
    .setImage(`attachment://${result.images[0].filename}`);
  if (state.player && result.links.length) {
    card.setDescription(`-# 🔗 ${result.links.map(link => `[${link.title.replace(/^View /, "")}](${link.url})`).join(" · ")}`);
  }
  const lower = result.images[1];
  return lower ? [card, new EmbedBuilder().setColor(color).setImage(`attachment://${lower.filename}`)] : [card];
}

// ─── Controls ───

// Menus hold 25 options: a page of logs or characters leaves room for
// previous and next, and the raid menu also for load-older and refresh.
const PAGE_SIZE = 22;
const RAID_PAGE_SIZE = 21;
const TAB_EMOJI = Object.freeze({
  damage: "⚔️", party_buffs: "🤝", party_buffs_all: "🤝", self_buffs: "💪", self_buffs_all: "💪",
  shields: "🛡️", shields_received: "🛡️", shields_blocked: "🛡️", shields_breakdown: "🛡️",
  tanked: "🩸", dps_average: "📈", dps_10s: "📉", damage_category: "🧩",
});

// The page offset of each previous/next entry pagedChoices adds. A Map, so a
// log id such as "toString" is never mistaken for one.
const PAGE_STEPS = new Map([["__prev", -1], ["__next", 1]]);

/**
 * @param {{ id: string, revision: number }} state panel session
 * @param {string} action
 * @returns {string} the custom id the component router hands back to /raid-log
 */
function raidLogCustomId(state, action) {
  return `raid-log:${state.id}:${state.revision}:${action}`;
}

/**
 * @param {object[]} choices menu options
 * @param {number} page zero-based page
 * @param {string} lang
 * @param {number} [size]
 * @returns {object[]} the page's options followed by previous/next entries
 */
function pagedChoices(choices, page, lang, size = PAGE_SIZE) {
  const shown = choices.slice(page * size, (page + 1) * size);
  if (page > 0) shown.push({ label: t("common.pagination.previous", lang), value: "__prev" });
  if ((page + 1) * size < choices.length) shown.push({ label: t("common.pagination.next", lang), value: "__next" });
  return shown;
}

function raidOptions(state, support) {
  const raids = new Map();
  for (const entry of state.catalog.logs) raids.set(entry.raidKey, [...(raids.get(entry.raidKey) || []), entry]);
  const options = [...raids].map(([raidKey, logs]) => {
    const percents = logs.map(entry => headlinePercent(entry, support, state.bracketed)).filter(percent => percent !== null);
    const best = percents.length ? Math.max(...percents) : null;
    return {
      label: truncateSelectText(t("raid-log.controls.raidOption", state.lang,
        { raid: logs[0].raidLabel, count: logs.length, best: formatPercent(best) }), 100),
      value: raidKey, emoji: { name: parseTier(best).emoji }, default: raidKey === state.selected.raidKey,
      description: t("raid-log.controls.raidOptionDetail", state.lang, { when: formatWhen(logs[0].timestamp) }),
    };
  });
  return [
    ...pagedChoices(options, state.raidPage, state.lang, RAID_PAGE_SIZE),
    ...(state.catalog.hasMore ? [{ label: t("raid-log.controls.loadMore", state.lang), value: "__more", emoji: { name: "⏬" },
      description: t("raid-log.controls.loadMoreDetail", state.lang) }] : []),
    { label: t("raid-log.controls.refresh", state.lang), value: "__refresh", emoji: { name: "🔄" },
      description: t("raid-log.controls.refreshDetail", state.lang) },
  ];
}

function logOptions(state, support) {
  const options = openRaidLogs(state).map(entry => {
    const percent = headlinePercent(entry, support, state.bracketed);
    return {
      label: truncateSelectText([`${entry.gate || entry.raidLabel} ${entry.difficulty}`.trim(), formatWhen(entry.timestamp),
        formatPercent(percent), ...logFigures(entry, support, state.lang)].join(" · "), 100),
      value: entry.id, emoji: { name: parseTier(percent).emoji }, default: entry.id === state.selected.id,
      // Bible's own names for the two figures behind the percent.
      description: support
        ? `rContribution ${formatPercent(percentOf(entry.contributionPercentile))} · Buff Performance ${formatPercent(percentOf(entry.percentile))}`
        : `Bracketed ${formatPercent(percentOf(entry.percentile))} · Normalized ${formatPercent(percentOf(entry.normalizedPercentile))}`,
    };
  });
  return pagedChoices(options, state.logPage, state.lang);
}

function playerOptions(state) {
  const { players, playerCount, partyCount } = state.result;
  const lookedUp = normalizeCharacterName(state.catalog.profile.name);
  return [
    { label: t("raid-log.controls.team", state.lang, { players: playerCount, parties: partyCount }), value: "__team",
      emoji: { name: "👥" }, description: t("raid-log.controls.teamDetail", state.lang), default: !state.player },
    ...players.map(player => {
      const { itemLevel, name } = splitLabel(player.label);
      const badges = player.badges[state.bracketed ? "bracketed" : "normalized"].map(badgeText).join(" · ");
      const description = [player.className, isSupportClass(player.className) && t("raid-log.controls.support", state.lang),
        normalizeCharacterName(name) === lookedUp && t("raid-log.controls.lookedUp", state.lang)].filter(Boolean).join(" · ");
      const emoji = parseCustomEmoji(getClassEmoji(player.className));
      return {
        label: truncateSelectText([name, itemLevel, badges, t("raid-log.controls.party", state.lang, { party: player.party })]
          .filter(Boolean).join(" · "), 100),
        value: player.id, default: player.id === state.player?.id,
        // Bible can omit a class icon; Discord rejects an empty description.
        ...(description ? { description: truncateSelectText(description, 100) } : {}),
        ...(emoji ? { emoji } : {}),
      };
    }),
  ];
}

function tabOptions(state, tabs) {
  const keys = Object.keys(tabs);
  const glossSet = state.player ? "player" : "team";
  return keys.map((key, index) => ({
    label: truncateSelectText(`${tabs[key]} · ${t(`raid-log.tabs.${glossSet}.${key}`, state.lang)}`, 100),
    value: key, emoji: { name: TAB_EMOJI[key] }, default: key === state.tab,
    description: t("raid-log.controls.tabDetail", state.lang, { index: index + 1, count: keys.length }),
  }));
}

/**
 * @param {object} state panel session
 * @param {boolean} [disabled] lock every control, as on a revoked panel
 * @returns {ActionRowBuilder[]} the button row, then the raid, log, player and tab menus
 */
function buildLogComponents(state, disabled = false) {
  const id = action => raidLogCustomId(state, action);
  const support = isSupportClass(state.catalog.profile.className);
  const tabs = tabsForPlayer(state.player, state.result);
  const tabKeys = Object.keys(tabs);
  const tabIndex = tabKeys.indexOf(state.tab);
  const button = (action, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(id(action)).setStyle(style).setDisabled(disabled);
  const select = (action, placeholder, options) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(id(action)).setPlaceholder(t(`raid-log.controls.${placeholder}`, state.lang)).setDisabled(disabled).addOptions(options));
  return [
    new ActionRowBuilder().addComponents(
      button("tab_prev").setEmoji("◀️").setDisabled(disabled || tabIndex === 0),
      button("tab_label").setEmoji(TAB_EMOJI[state.tab]).setLabel(`${tabs[state.tab]} · ${tabIndex + 1}/${tabKeys.length}`).setDisabled(true),
      button("tab_next").setEmoji("▶️").setDisabled(disabled || tabIndex === tabKeys.length - 1),
      button("bracketed", state.bracketed ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji("📐")
        .setLabel(state.bracketed ? "Bracketed" : "Normalized"),
      button("reset").setEmoji("↩️").setLabel(t("raid-log.controls.reset", state.lang)),
    ),
    select("raid", "raidPlaceholder", raidOptions(state, support)),
    select("log", "logPlaceholder", logOptions(state, support)),
    select("player", "playerPlaceholder", playerOptions(state)),
    select("tab", "tabPlaceholder", tabOptions(state, tabs)),
  ];
}

/**
 * A card's controls while a request runs: every control is disabled, and the
 * menu that was used shows the picked option instead of its placeholder.
 * @param {ActionRowBuilder[]} rows the card's controls
 * @param {{customId: string, values?: string[]}} interaction the click being handled
 * @returns {ActionRowBuilder[]} the waiting controls
 */
function buildWaitingComponents(rows, { customId, values = [] }) {
  const picked = new Set(values);
  return rows.map(row => {
    const json = row.toJSON();
    return new ActionRowBuilder({
      ...json,
      components: json.components.map(component => ({
        ...component,
        disabled: true,
        ...(component.custom_id === customId && component.options
          ? { options: component.options.map(option => ({ ...option, default: picked.has(option.value) })) }
          : {}),
      })),
    });
  });
}

module.exports = {
  buildLogComponents, buildLogEmbeds, buildWaitingComponents, headlinePercent, openRaidLogs,
  raidLogCustomId, pagedChoices, PAGE_STEPS, PAGE_SIZE,
};
