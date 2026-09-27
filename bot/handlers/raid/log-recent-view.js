"use strict";

/**
 * bot/handlers/raid/log-recent-view.js
 * "Log gần đây": the newest public logs across the caller's saved roster,
 * ten fights on the card and a menu that opens any of the newest 25.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { t } = require("../../services/i18n");
const { getClassEmoji } = require("../../models/Class");
const { truncateSelectText } = require("../../utils/discord/select-options");
const { parseTier } = require("../../services/raid-log/parse-tiers");
const { formatCompact, percentOf, formatPercent, formatShare, formatClock, formatWhen } = require("../../services/raid-log/format");
const { MAX_RECENT_CHARACTERS } = require("../../services/raid-log/recent");
const { headlinePercent } = require("./log-view");

const CARD_ENTRIES = 10;
const MAX_PRIVATE_NAMES = 10;

// A dealer's percentile, or a support's rContribution and Buff Performance, as Bible's badges read.
const badgesOf = entry => (entry.support ? [entry.contributionPercentile, entry.percentile] : [entry.percentile])
  .map(fraction => percentOf(fraction) ?? "-").join(" · ");
const tierOf = entry => parseTier(headlinePercent(entry, entry.support, true));
const fightName = entry => [entry.raidLabel, entry.gate].filter(Boolean).join(" ");

// Bible's dashboard columns: percent, DPS and nDPS for a dealer; for a support
// the two badges, AP/Brand/Identity/T uptime and rContribution.
function recentDetail(entry) {
  const clock = `⏱ ${formatClock(entry.duration)}`;
  if (entry.support) {
    const uptime = entry.buffs ? entry.buffs.map(buff => percentOf(buff) ?? "-").join("·") : "-";
    return [badgesOf(entry), `uptime ${uptime}`, `${formatShare(entry.rContribution)} rCon`, clock].join(" · ");
  }
  return [formatPercent(percentOf(entry.percentile)), `${formatCompact(entry.dps)} DPS`, `${formatCompact(entry.ndps)} nDPS`, clock,
    ...(entry.isDead ? ["💀"] : [])].join(" · ");
}

function footerLine(recent, lang) {
  const parts = [];
  if (recent.private.length) {
    const rest = recent.private.length - MAX_PRIVATE_NAMES;
    const names = recent.private.slice(0, MAX_PRIVATE_NAMES).join(", ");
    parts.push(t("raid-log.recent.private", lang, { names: rest > 0 ? `${names} +${rest}` : names }));
  }
  if (recent.entries.length) parts.push(t("raid-log.recent.summary", lang, { logs: recent.logs, characters: recent.characters }));
  if (recent.capped) parts.push(t("raid-log.recent.capped", lang, { count: MAX_RECENT_CHARACTERS }));
  if (recent.timedOut) parts.push(t("raid-log.recent.timedOut", lang));
  return parts.length ? `-# ${parts.join(" · ")}` : "";
}

const recentCard = (EmbedBuilder, UI, lang, description) => new EmbedBuilder().setColor(UI.colors.neutral)
  .setTitle(`🕘 ${t("raid-log.recent.title", lang)}`).setDescription(description);

/**
 * @param {object} state session in the recent stage
 * @returns {object[]} one option per entry; the value is the entry's index because
 *   two of the caller's characters can share one log
 */
function recentOptions(state) {
  return state.recent.entries.map((entry, index) => ({
    label: truncateSelectText([[fightName(entry), entry.difficulty].filter(Boolean).join(" "), entry.character, badgesOf(entry)].join(" · "), 100),
    value: String(index), emoji: { name: tierOf(entry).emoji },
    description: truncateSelectText(`${recentDetail(entry)} · ${formatWhen(entry.timestamp)}`, 100),
  }));
}

/**
 * @param {object} state picker or recent session
 * @param {number} count characters the load asks Bible about
 * @param {{ EmbedBuilder: Function, UI: object }} builders
 * @returns {object} message payload with no controls
 */
function buildRecentLoading(state, count, { EmbedBuilder, UI }) {
  const description = `${t("raid-log.recent.loading", state.lang, { count })}\n-# ${t("raid-log.recent.loadingHint", state.lang)}`;
  return { content: null, embeds: [recentCard(EmbedBuilder, UI, state.lang, description)], components: [], allowedMentions: { parse: [] } };
}

/**
 * @param {object} state session in the recent stage (`recent` from the recent service)
 * @param {{ EmbedBuilder: Function, UI: object }} builders
 * @returns {object} message payload
 */
function buildRecentView(state, { EmbedBuilder, UI }) {
  const { recent, lang } = state;
  const id = action => `raid-log:${state.id}:${state.revision}:${action}`;
  const lines = recent.entries.length
    ? recent.entries.slice(0, CARD_ENTRIES).flatMap(entry => [
      [[`${tierOf(entry).emoji} **${fightName(entry)}**`, entry.difficulty].filter(Boolean).join(" "),
        [getClassEmoji(entry.className), entry.character].filter(Boolean).join(" "), `<t:${Math.floor(entry.timestamp / 1000)}:R>`].join(" · "),
      `-# ${recentDetail(entry)}`,
    ])
    : [t("raid-log.recent.empty", lang)];
  const footer = footerLine(recent, lang);
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id("picker")).setEmoji("↩️").setLabel(t("raid-log.recent.back", lang)).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id("recent_refresh")).setEmoji("🔄").setLabel(t("raid-log.controls.refresh", lang))
      .setStyle(ButtonStyle.Secondary),
  )];
  // Discord rejects a menu without options.
  if (recent.entries.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id("recent"))
      .setPlaceholder(t("raid-log.recent.open", lang)).addOptions(recentOptions(state))));
  }
  return {
    content: null, components, allowedMentions: { parse: [] },
    embeds: [recentCard(EmbedBuilder, UI, lang, [...lines, ...(footer ? ["", footer] : [])].join("\n"))],
  };
}

module.exports = { buildRecentLoading, buildRecentView, recentOptions };
