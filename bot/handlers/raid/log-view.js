"use strict";

/**
 * bot/handlers/raid/log-view.js
 * The /raid-log log-book card (MVP, score and fight fields, the raid's
 * latest logs, the capture) and its controls.
 */

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { t } = require("../../services/i18n");
const { getClassEmoji, isSupportClass } = require("../../models/Class");
const { tabsForPlayer } = require("../../services/raid-log/tabs");
const { pickHighlights } = require("../../services/raid-log/highlights");
const { parseTier } = require("../../services/raid-log/parse-tiers");
const { formatCompact, percentOf, formatPercent, formatShare, formatClock, formatWhen } = require("../../services/raid-log/format");

const PAGE_SIZE = 22; // Leave room for previous, next and loading older logs.
const timestamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

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

/**
 * @param {string} summary Bible's fight summary text
 * @returns {{ duration: string|null, totalDamage: string|null, teamDps: string|null }} in Bible's own wording
 */
function parseSummary(summary) {
  const duration = /Duration:\s*([\d:]+)(?:\s*(\+[\d:]+))?/.exec(summary);
  return {
    duration: duration ? duration.slice(1).filter(Boolean).join(" ") : null,
    totalDamage: /Total DMG:\s*([\d,]+)/.exec(summary)?.[1] ?? null,
    teamDps: /Total DPS:\s*([\d,]+)/.exec(summary)?.[1] ?? null,
  };
}

// Custom emoji do not render inside code spans, so the name sits above its chip.
function highlightFields(players, bracketed, lang) {
  const { damage, dealerScore, counter, support, supportContribution, supportUptime } = pickHighlights(players, bracketed);
  const person = (pick, chip) => `${[getClassEmoji(pick.player.className), `**${splitLabel(pick.player.label).name}**`]
    .filter(Boolean).join(" ")}\n\`${chip}\``;
  const noSupport = `${t("raid-log.values.noSupport", lang)}\n\`-\``;
  const contributionChip = pick => [badgeText(pick.badge), ...(pick.contribution === null ? [] : [`${pick.contribution}% rCon`])].join(" · ");
  return [
    field("👑", "mvpDamage", damage ? person(damage, damage.share === null ? "-" : `${damage.share}% D%`) : "`-`", lang),
    field("📈", "scoreDealer", dealerScore ? person(dealerScore, dealerScore.badge === null ? "-"
      : `${badgeText(dealerScore.badge)} · ${formatCompact(dealerScore.ndps)} nDPS`) : "`-`", lang),
    field("🎯", "mvpCounter", counter ? person(counter, [t("raid-log.values.counter", lang, { count: counter.counters }),
      ...(counter.tied ? [`${formatCompact(counter.stagger)} STAG`] : [])].join(" · "))
      : `${t("raid-log.values.noCounter", lang)}\n\`0\``, lang),
    field("✨", "mvpSupport", support ? person(support, support.share === null ? "-" : `${support.share}% bD%`) : noSupport, lang),
    field("🤝", "supportContribution", supportContribution
      ? person(supportContribution, supportContribution.badge === null ? "-" : contributionChip(supportContribution)) : noSupport, lang),
    field("⏱️", "supportUptime", supportUptime
      ? person(supportUptime, supportUptime.badge === null ? "-" : badgeText(supportUptime.badge)) : noSupport, lang),
  ];
}

function fightFields(summary, lang) {
  const fight = parseSummary(summary);
  return [["⏱", "duration"], ["⚔", "totalDamage"], ["📊", "teamDps"]]
    .map(([emoji, key]) => field(emoji, key, `\`${fight[key] ?? "-"}\``, lang));
}

// The figures after a log's headline percent, shared by the history and the log menu.
function logFigures(entry, support, lang) {
  const figures = support
    ? [`${formatPercent(percentOf(entry.percentile))} ${t("raid-log.values.uptime", lang)}`, `${formatShare(entry.rContribution)} rCon`]
    : [`${formatCompact(entry.dps)} DPS`, `${formatCompact(entry.ndps)} nDPS`];
  return [...figures, `⏱ ${formatClock(entry.duration)}`, ...(entry.isDead ? ["💀"] : []), ...(entry.isBus ? ["🚌"] : [])];
}

function historyField(state, support) {
  const shown = state.catalog.logs.filter(entry => entry.raidKey === state.selected.raidKey).slice(0, HISTORY_SIZE);
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
 * @param {object} result capture metadata: players, summary, url, links, images[].filename
 * @param {{ EmbedBuilder: Function, UI: object }} builders
 * @returns {import("discord.js").EmbedBuilder[]} the card, plus an image-only embed for a player's lower image
 */
function buildLogEmbeds(state, result, { EmbedBuilder, UI }) {
  const support = isSupportClass(state.catalog.profile.className);
  const color = parseTier(headlinePercent(state.selected, support, state.bracketed)).color ?? UI.colors.neutral;
  const card = new EmbedBuilder().setColor(color).setURL(result.url)
    .setTitle(`📜 ${t("raid-log.panel.title", state.lang, { raid: state.selected.raidLabel, character: state.catalog.profile.name })}`)
    .addFields(...highlightFields(result.players, state.bracketed, state.lang), ...fightFields(result.summary, state.lang),
      historyField(state, support))
    .setImage(`attachment://${result.images[0].filename}`);
  if (state.player && result.links.length) {
    card.setDescription(`-# 🔗 ${result.links.map(link => `[${link.title.replace(/^View /, "")}](${link.url})`).join(" · ")}`);
  }
  const lower = result.images[1];
  return lower ? [card, new EmbedBuilder().setColor(color).setImage(`attachment://${lower.filename}`)] : [card];
}

module.exports = { buildLogComponents, buildLogEmbeds, parseSummary, headlinePercent, pagedChoices, PAGE_SIZE };
