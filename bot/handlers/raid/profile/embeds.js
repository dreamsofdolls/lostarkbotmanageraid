"use strict";

const { t } = require("../../../services/i18n");
const { getClassEmoji } = require("../../../models/Class");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");
const {
  aggregateCharacters,
  flattenCharacters,
  getEntryLabel,
  pickTopChar,
} = require("./aggregate");
const {
  arkPassiveSummary,
  buildVariantSummary,
  contextScoreLine,
  engravingSummary,
  enlightenmentSummary,
} = require("./view-helpers");
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
  renderPercentGauge,
  roleLabel,
  score,
  scoreLine,
  shortNumber,
  sourceSummary,
  sourceSummaryForEntries,
  sourceTag,
} = require("./display");
const {
  reliabilityLines,
  roleDetailLines,
  sourceOrCombatShapeLines,
} = require("./character-lines");

function appendOverflowLine(lines, total, limit, label = "more") {
  const extra = Math.max(0, Number(total) - Number(limit));
  if (extra > 0) lines.push(`\`…\` +${extra} ${label}`);
  return lines;
}

function sliceMapWithOverflow(items, limit, mapper, label = "more") {
  const list = Array.isArray(items) ? items : [];
  const lines = list.slice(0, limit).map(mapper);
  return appendOverflowLine(lines, list.length, limit, label);
}

function buildOverallEmbed({ EmbedBuilder, UI }, session) {
  const lang = session.lang || "vi";
  const chars = flattenCharacters(session.entries);
  const agg = aggregateCharacters(chars);
  const topOverall = pickTopChar(chars, "overall");
  const topMvp = pickTopChar(chars, "mvp");
  const embed = new EmbedBuilder()
    .setColor(UI.colors.neutral)
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

function buildRosterEmbed({ EmbedBuilder, UI }, session, entry) {
  const lang = session.lang || "vi";
  const agg = aggregateCharacters(entry.characters);
  const topOverall = pickTopChar(entry.characters, "overall");
  const embed = new EmbedBuilder()
    .setColor(entry.isOwn ? UI.colors.neutral : UI.colors.progress)
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

function buildCharacterEmbed({ EmbedBuilder, UI }, session, entry, character) {
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
    .setColor(isSupport ? UI.colors.success : UI.colors.neutral)
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

  if (character.classRole === "support") {
    embed.addFields({
      name: hudFieldName("role detection"),
      value: [
        `Class role: **SUP** · scored as **${roleLabel(character)}**`,
        `SUP logs: **${Math.round(Number(stats.supportLogCount) || 0)}** (${pct(stats.supportLogRate)})`,
        `DPS-build logs: **${Math.round(Number(stats.dpsBuildLogCount) || 0)}** (${pct(stats.dpsBuildLogRate)})`,
        `Used for score: **${Math.round(Number(stats.encounters) || 0)} / ${Math.round(Number(stats.allEncounterCount) || Number(stats.encounters) || 0)}** (${pct(stats.primaryRoleRate || 100)})`,
      ].join("\n"),
      inline: false,
    });
  }

  if (!isBibleSummary) {
    embed.addFields({
      name: hudFieldName("buff profile"),
      value: [
        `Party attr buff/debuff: **${pct(stats.avgPartyBuffedShare)}** / **${pct(stats.avgPartyDebuffedShare)}**`,
        `Self attr / battle item: **${pct(stats.avgSelfBuffedShare)}** / **${pct(stats.avgBattleItemDebuffedShare)}**`,
        `Top buff: ${sourceSummary(character.topBuffSources)}`,
        `Top debuff: ${sourceSummary(character.topDebuffSources)}`,
        `Shield given: ${sourceSummary(character.topShieldGivenSources, 2)}`,
        `Shield received: ${sourceSummary(character.topShieldReceivedSources, 2)}`,
      ].join("\n"),
      inline: false,
    });
  }

  const build = character.build || {};
  if (build.spec || build.gearScore || build.combatPower || build.engravings?.length || build.arkPassive || character.buildVariants?.length) {
    embed.addFields({
      name: hudFieldName("build"),
      value: [
        // combatPower is a raw magnitude (~millions) - format like DPS via
        // shortNumber, not score() which is the 0-100 gauge formatter.
        `CP: **${build.combatPower ? shortNumber(build.combatPower) : "N/A"}**`,
        `Ark passive: **${build.arkPassiveActive === null || build.arkPassiveActive === undefined ? "N/A" : build.arkPassiveActive ? "ON" : "OFF"}** / rate ${pct(stats.arkPassiveRate)}`,
        `Build variants: **${Math.round(Number(stats.buildVariantCount) || 0)}**`,
        `Unclassified build logs: **${Math.round(Number(stats.unclassifiedBuildLogCount) || 0)}**`,
        `Variant split: ${buildVariantSummary(character.buildVariants)}`,
        `Engravings: ${engravingSummary(build.engravings)}`,
        `Ark points: ${arkPassiveSummary(build.arkPassive)}`,
        `Enlightenment: ${enlightenmentSummary(build.arkPassive, build.spec)}`,
      ].join("\n"),
      inline: false,
    });
  }

  const skillLines = sliceMapWithOverflow(character.topSkills || [], 5, (skill, index) => (
    `\`${index + 1}.\` **${skill.name || "Unknown"}** · ${renderPercentGauge(skill.share)} · crit ${pct(skill.critRate)}`
  ));
  if (skillLines.length) {
    embed.addFields({
      name: hudFieldName("top skills"),
      value: skillLines.join("\n"),
      inline: false,
    });
  }

  const sortedRaids = [...(character.raids || [])]
    .sort((a, b) => Number(b?.encounters || 0) - Number(a?.encounters || 0));
  const raidLines = sliceMapWithOverflow(sortedRaids, 8, (raid) => {
    const raidLabel = getRaidModeLabel(raid.raidKey, raid.modeKey, lang) || `${raid.raidKey} ${raid.modeKey}`;
    if (isBibleSummary) {
      return `**${raidLabel}** · ${raid.boss || "?"} · ${raid.encounters || 0} log · DPS ${shortNumber(raid.medianDps)} · Bible pct ${pct(raid.avgBiblePercentile)} · deathless ${pct(raid.deathlessRate)}`;
    }
    return `**${raidLabel}** · ${raid.boss || "?"} · ${raid.encounters || 0} log · DPS ${shortNumber(raid.medianDps)} · share ${pct(raid.avgDamageShare)} · top ${pct(raid.topRate)}`;
  });
  embed.addFields({
    name: hudFieldName("raid breakdown"),
    value: raidLines.length ? raidLines.join("\n") : t("raidProfile.noRaidBreakdown", lang),
    inline: false,
  });
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
