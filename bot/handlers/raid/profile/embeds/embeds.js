"use strict";

const { t } = require("../../../../services/i18n");
const { getClassEmoji } = require("../../../../models/Class");
const {
  aggregateCharacters,
  flattenCharacters,
  getEntryLabel,
  pickTopChar,
} = require("../helpers/aggregate");
const {
  contextScoreLine,
} = require("../helpers/view-helpers");
const {
  confidenceForLogs,
  footerTimestamp,
  formatDateMs,
  hudFieldName,
  isBibleSummaryProfile,
  latestSnapshotMs,
  pct,
  rangeTag,
  renderGauge,
  roleLabel,
  score,
  scoreLine,
  sourceSummaryForEntries,
  sourceTag,
} = require("../helpers/display");
const {
  reliabilityLines,
  roleDetailLines,
  sourceOrCombatShapeLines,
} = require("./character-lines");
const {
  buildCharacterExtraFields,
} = require("./character-fields");
const {
  sliceMapWithOverflow,
} = require("../helpers/list-lines");
const { PROFILE_COLORS } = require("../helpers/colors");

function buildOverallEmbed({ EmbedBuilder }, session) {
  const lang = session.lang || "vi";
  const chars = flattenCharacters(session.entries);
  const agg = aggregateCharacters(chars);
  const topOverall = pickTopChar(chars, "overall");
  const topMvp = pickTopChar(chars, "mvp");
  const embed = new EmbedBuilder()
    .setColor(PROFILE_COLORS.amber)
    .setAuthor({ name: "// RAID PROFILE · OVERALL" })
    .setTitle(t("raidProfile.overallTitle", lang))
    .setDescription(t("raidProfile.overallDesc", lang))
    .addFields(
      {
        name: hudFieldName("scope"),
        value: [
          `Roster: **${session.entries.length}**`,
          `Character: **${agg.charCount}**`,
          `${t("raidProfile.validLogs", lang)}: **${agg.logs}**`,
          `Scored logs: **${agg.scoredLogs}**`,
          `${t("raidProfile.lastFight", lang)}: ${formatDateMs(agg.lastFightStart)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("aggregate score"),
        value: [
          scoreLine("Overall", agg.overall),
          scoreLine("MVP", agg.mvp),
          agg.dpsCount ? scoreLine("DPS avg", agg.dpsOverall) : "DPS avg: **N/A**",
          agg.supportCount ? scoreLine("SUP avg", agg.supportOverall) : "SUP avg: **N/A**",
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("top"),
        value: [
          topOverall ? `★ Overall: **${topOverall.name}** ${renderGauge(topOverall.scores.overall)}` : "Overall: N/A",
          topMvp ? `★ MVP: **${topMvp.name}** ${renderGauge(topMvp.scores.mvp)}` : "MVP: N/A",
        ].join("\n"),
        inline: false,
      }
    );

  const rosterLines = sliceMapWithOverflow(session.entries, 10, (entry, index) => {
    const rosterAgg = aggregateCharacters(entry.characters);
    const prefix = entry.isOwn ? "Own" : "Shared";
    return `\`${index + 1}.\` **${getEntryLabel(entry)}** · ${prefix} · ${rosterAgg.charCount} char · ${rosterAgg.logs} log · score ${score(rosterAgg.overall)}`;
  });
  embed.addFields({
    name: hudFieldName("roster"),
    value: rosterLines.length ? rosterLines.join("\n") : t("raidProfile.noProfiles", lang),
    inline: false,
  });
  embed.setFooter({
    text: `// ${sourceSummaryForEntries(session.entries)} · ${footerTimestamp(latestSnapshotMs(session.entries))} · ${agg.logs} LOG · ${agg.scoredLogs} SCORED · CONF ${confidenceForLogs(agg.scoredLogs).toUpperCase()}`,
  });

  return embed;
}

function buildRosterEmbed({ EmbedBuilder }, session, entry) {
  const lang = session.lang || "vi";
  const agg = aggregateCharacters(entry.characters);
  const topOverall = pickTopChar(entry.characters, "overall");
  const embed = new EmbedBuilder()
    .setColor(entry.isOwn ? PROFILE_COLORS.amber : PROFILE_COLORS.shared)
    .setAuthor({ name: "// RAID PROFILE · ROSTER" })
    .setTitle(t("raidProfile.rosterTitle", lang, { account: entry.accountName }))
    .setDescription([
      entry.isOwn
        ? t("raidProfile.rosterOwn", lang)
        : t("raidProfile.rosterShared", lang, { owner: entry.ownerLabel || entry.ownerDiscordId, level: entry.accessLevel }),
      t("raidProfile.updatedAt", lang, { date: formatDateMs(entry.receivedAt || entry.generatedAt) }),
    ].join("\n"))
    .addFields(
      {
        name: hudFieldName("scope"),
        value: [
          `Character: **${agg.charCount}**`,
          `${t("raidProfile.validLogs", lang)}: **${agg.logs}**`,
          `Scored logs: **${agg.scoredLogs}**`,
          scoreLine("Overall", agg.overall),
          scoreLine("MVP", agg.mvp),
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("role split"),
        value: [
          `DPS: **${agg.dpsCount}** · ${agg.dpsCount ? score(agg.dpsOverall) : "N/A"}`,
          `SUP: **${agg.supportCount}** · ${agg.supportCount ? score(agg.supportOverall) : "N/A"}`,
          topOverall ? `Top: **${topOverall.name}** ${renderGauge(topOverall.scores.overall)}` : "Top: N/A",
        ].join("\n"),
        inline: true,
      }
    );

  const sortedCharacters = [...entry.characters]
    .sort((a, b) => Number(b?.scores?.overall || 0) - Number(a?.scores?.overall || 0));
  const lines = sliceMapWithOverflow(sortedCharacters, 12, (character, index) => {
    const logs = Number(character?.stats?.encounters) || 0;
    return `\`${index + 1}.\` **${character.name}** · ${roleLabel(character)} · ${logs} scored · score ${score(character?.scores?.overall)} · MVP ${score(character?.scores?.mvp)}`;
  });
  embed.addFields({
    name: hudFieldName("character"),
    value: lines.length ? lines.join("\n") : t("raidProfile.noChars", lang),
    inline: false,
  });
  embed.setFooter({
    text: `// ${entry.isOwn ? "OWN" : "SHARED"} · ${sourceTag(entry.source)} ${rangeTag(entry.rangeType)} · ${footerTimestamp(entry.receivedAt || entry.generatedAt)} · ${agg.logs} LOG · ${agg.scoredLogs} SCORED · CONF ${confidenceForLogs(agg.scoredLogs).toUpperCase()}`,
  });

  return embed;
}

function buildCharacterEmbed({ EmbedBuilder }, session, entry, character) {
  const lang = session.lang || "vi";
  const stats = character.stats || {};
  const scores = character.scores || {};
  const isSupport = character.role === "support";
  const isBibleSummary = isBibleSummaryProfile(entry, character);
  // Playstyle/spec comes from the enlightenment node (getSpecFromArkPassiveNodes);
  // fall back to the raw build.spec, then nothing. Surfaced as a badge in the
  // header (inline code) instead of a buried Build line.
  const spec = character.build?.arkPassive?.enlightenment?.spec || character.build?.spec || "";
  // Custom class emoji renders in the description (not in titles), so the class
  // icon lives on the identity line, not the title.
  const classEmoji = getClassEmoji(character.class) || (isSupport ? "🛡️" : "⚔️");
  const embed = new EmbedBuilder()
    .setColor(isSupport ? PROFILE_COLORS.support : PROFILE_COLORS.amber)
    .setAuthor({ name: "// RAID PROFILE · CHARACTER" })
    .setTitle(character.name)
    .setDescription([
      `${classEmoji} **${character.class || "Unknown"}** · ${roleLabel(character)} · iLvl **${character.itemLevel || 0}**${spec ? ` · \`${spec}\`` : ""}`,
      `Roster: **${getEntryLabel(entry)}**`,
      t("raidProfile.confidence", lang, { conf: confidenceForLogs(stats.encounters), n: stats.encounters || 0 }),
    ].join("\n"))
    .addFields(
      {
        name: hudFieldName("score"),
        value: [
          scoreLine("Overall", scores.overall),
          scoreLine("MVP", scores.mvp),
          contextScoreLine(entry, character),
          scoreLine("Survival", scores.survival),
          scoreLine("Consistency", scores.consistency),
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(isSupport ? "SUP detail" : "DPS detail"),
        value: roleDetailLines(stats, scores, { isSupport, isBibleSummary }).join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(isBibleSummary ? "source detail" : "combat shape"),
        value: sourceOrCombatShapeLines(entry, stats, { isBibleSummary }).join("\n"),
        inline: false,
      },
      {
        name: hudFieldName("reliability"),
        value: reliabilityLines(stats, { isBibleSummary, lang }).join("\n"),
        inline: false,
      }
    );

  embed.addFields(...buildCharacterExtraFields(character, { lang, isBibleSummary }));
  embed.setFooter({
    text: `// ${sourceTag(entry.source)} ${rangeTag(entry.rangeType)} · ${String(character.class || "UNKNOWN").toUpperCase()} · ${roleLabel(character).toUpperCase()} · ${stats.encounters || 0} SCORED · CONF ${confidenceForLogs(stats.encounters).toUpperCase()} · ${footerTimestamp(entry.receivedAt || entry.generatedAt)}`,
  });

  return embed;
}

module.exports = {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
};
