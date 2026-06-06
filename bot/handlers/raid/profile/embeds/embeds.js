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
  confidenceLabelForLogs,
  footerTimestamp,
  formatDateMs,
  hudFieldName,
  isBibleSummaryProfile,
  latestSnapshotMs,
  rangeTag,
  roleEmoji,
  roleLabel,
  score,
  scoreLine,
  sourceSummaryForEntries,
  sourceTag,
} = require("../helpers/display");
const {
  buildBuildFields,
} = require("./character-lines");
const {
  sliceMapWithOverflow,
} = require("../helpers/list-lines");
const { PROFILE_COLORS } = require("../helpers/colors");

function buildSpecName(build, fallback = "") {
  return String(build?.arkPassive?.enlightenment?.spec || build?.spec || fallback || "").trim();
}

function roleTagForBuild(role, lang = "vi") {
  return role === "support"
    ? t("raidProfile.labels.supportBuild", lang)
    : t("raidProfile.labels.dps", lang);
}

function footerText(parts) {
  return `// ${parts.filter(Boolean).join(" · ")}`;
}

function totalCharacterLogs(character) {
  const primary = Number(character?.stats?.encounters) || 0;
  const alt = Number(character?.altBuild?.encounters) || 0;
  const all = Number(character?.stats?.allEncounterCount) || 0;
  return Math.round(Math.max(primary + alt, primary, all));
}

function buildDisplayBuilds(character) {
  const builds = [{
    source: "primary",
    role: character?.role === "support" ? "support" : "dps",
    encounters: Number(character?.stats?.encounters) || 0,
    stats: character?.stats || {},
    scores: character?.scores || {},
    build: character?.build || null,
    spec: buildSpecName(character?.build, character?.build?.spec || ""),
  }];
  const altBuild = character?.altBuild || null;
  if (altBuild) {
    builds.push({
      source: "alt",
      role: altBuild.role === "support" ? "support" : "dps",
      encounters: Number(altBuild.encounters) || Number(altBuild.stats?.encounters) || 0,
      stats: altBuild.stats || {},
      scores: altBuild.scores || {},
      build: altBuild.build || null,
      spec: buildSpecName(altBuild.build, altBuild.spec || ""),
    });
    builds.sort((a, b) =>
      b.encounters - a.encounters ||
      (a.source === "primary" ? -1 : 1)
    );
  }
  return builds;
}

// Compact code-block roster table for the OVERALL view (ops-brief look). A
// fenced code block is the only way to get true column alignment in a Discord
// embed - proportional field text drifts. Ranked best-first; the numeric score
// carries the signal because a per-row gauge would push the line past the
// ~42-col embed code-block wrap point and detach the score onto the next line.
// Rows cap at 10 with an overflow tail.
function buildRosterTable(entries, lang) {
  if (!entries.length) return t("raidProfile.noProfiles", lang);
  const NAME_W = 14;
  const CAP = 10;
  const fitName = (value) => {
    const str = String(value || "");
    return str.length > NAME_W ? `${str.slice(0, NAME_W - 1)}…` : str.padEnd(NAME_W);
  };
  const ranked = entries
    .map((entry) => ({ entry, agg: aggregateCharacters(entry.characters) }))
    .sort((a, b) => Number(b.agg.overall || 0) - Number(a.agg.overall || 0));
  const header = `${"#".padStart(2)} ${t("raidProfile.table.rosterName", lang).padEnd(NAME_W)} ${t("raidProfile.table.characters", lang).padStart(6)} ${t("raidProfile.table.logs", lang).padStart(5)}  ${t("raidProfile.table.score", lang).padStart(5)}`;
  const rows = ranked.slice(0, CAP).map(({ entry, agg }, index) => {
    return `${String(index + 1).padStart(2)} ${fitName(getEntryLabel(entry))} ${String(agg.charCount).padStart(4)} ${String(agg.logs).padStart(5)}  ${score(agg.overall).padStart(5)}`;
  });
  if (entries.length > CAP) {
    rows.push(t("raidProfile.table.moreRosters", lang, { count: entries.length - CAP }));
  }
  return `\`\`\`\n${[header, ...rows].join("\n")}\n\`\`\``;
}

function buildOverallEmbed({ EmbedBuilder }, session) {
  const lang = session.lang || "vi";
  const chars = flattenCharacters(session.entries);
  const agg = aggregateCharacters(chars);
  const topOverall = pickTopChar(chars, "overall");
  // Roster + character counts move up into the kicker so the SCOPE field can
  // shed its two count rows and share the top row with AGGREGATE 50/50.
  const embed = new EmbedBuilder()
    .setColor(PROFILE_COLORS.amber)
    .setAuthor({
      name: t("raidProfile.author.overall", lang, { rosters: session.entries.length, characters: agg.charCount }),
    })
    .setTitle(t("raidProfile.overallTitle", lang))
    .addFields(
      {
        name: hudFieldName(t("raidProfile.sections.scope", lang)),
        value: [
          t("raidProfile.lines.logScored", lang, { logs: agg.logs, scored: agg.scoredLogs }),
          `${t("raidProfile.lastFight", lang)}: ${formatDateMs(agg.lastFightStart)}`,
          topOverall
            ? t("raidProfile.lines.topCharacter", lang, { icon: getClassEmoji(topOverall.class) || roleEmoji(topOverall), name: topOverall.name, score: score(topOverall.scores.overall) })
            : t("raidProfile.lines.topMissing", lang),
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(t("raidProfile.sections.aggregate", lang)),
        value: [
          scoreLine(t("raidProfile.labels.scoreOverall", lang), agg.overall),
          scoreLine(t("raidProfile.labels.scoreMvp", lang), agg.mvp),
          agg.dpsCount ? scoreLine(t("raidProfile.labels.dps", lang), agg.dpsOverall) : `${t("raidProfile.labels.dps", lang)}: **N/A**`,
          agg.supportCount ? scoreLine(roleTagForBuild("support", lang), agg.supportOverall) : `${roleTagForBuild("support", lang)}: **N/A**`,
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(t("raidProfile.sections.roster", lang)),
        value: buildRosterTable(session.entries, lang),
        inline: false,
      }
    );

  embed.setFooter({
    text: footerText([
      sourceSummaryForEntries(session.entries, lang),
      footerTimestamp(latestSnapshotMs(session.entries), lang),
      t("raidProfile.footer.logCount", lang, { logs: agg.logs }),
      t("raidProfile.footer.scoredCount", lang, { scored: agg.scoredLogs }),
      t("raidProfile.footer.confidence", lang, { confidence: confidenceLabelForLogs(agg.scoredLogs, lang) }),
    ]),
  });

  return embed;
}

function buildRosterEmbed({ EmbedBuilder }, session, entry) {
  const lang = session.lang || "vi";
  const agg = aggregateCharacters(entry.characters);
  const topOverall = pickTopChar(entry.characters, "overall");
  // Counts + own/shared move into the kicker (ops-brief, mirrors the OVERALL
  // view); SCOPE keeps just the scored headline + gauges. Shared rosters still
  // surface owner+access in the meta line since that carries real info.
  const updated = t("raidProfile.updatedAt", lang, { date: formatDateMs(entry.receivedAt || entry.generatedAt) });
  const metaLine = entry.isOwn
    ? updated
    : `${t("raidProfile.rosterShared", lang, { owner: entry.ownerLabel || entry.ownerDiscordId, level: entry.accessLevel })} · ${updated}`;
  const embed = new EmbedBuilder()
    .setColor(entry.isOwn ? PROFILE_COLORS.amber : PROFILE_COLORS.shared)
    .setAuthor({
      name: t("raidProfile.author.roster", lang, {
        account: String(entry.accountName || "").toUpperCase(),
        characters: agg.charCount,
        ownership: entry.isOwn ? t("raidProfile.owner.own", lang) : t("raidProfile.owner.shared", lang),
      }),
    })
    .setTitle(t("raidProfile.rosterTitle", lang, { account: entry.accountName }))
    .setDescription(metaLine)
    .addFields(
      {
        name: hudFieldName(t("raidProfile.sections.scope", lang)),
        value: [
          t("raidProfile.lines.logScored", lang, { logs: agg.logs, scored: agg.scoredLogs }),
          scoreLine(t("raidProfile.labels.scoreOverall", lang), agg.overall),
          scoreLine(t("raidProfile.labels.scoreMvp", lang), agg.mvp),
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(t("raidProfile.sections.roleSplit", lang)),
        value: [
          `${t("raidProfile.labels.dps", lang)}: **${agg.dpsCount}** · ${agg.dpsCount ? score(agg.dpsOverall) : "N/A"}`,
          `${roleTagForBuild("support", lang)}: **${agg.supportCount}** · ${agg.supportCount ? score(agg.supportOverall) : "N/A"}`,
          topOverall
            ? t("raidProfile.lines.topCharacter", lang, { icon: getClassEmoji(topOverall.class) || roleEmoji(topOverall), name: topOverall.name, score: score(topOverall.scores.overall) })
            : t("raidProfile.lines.topMissing", lang),
        ].join("\n"),
        inline: true,
      }
    );

  const sortedCharacters = [...entry.characters]
    .sort((a, b) => Number(b?.scores?.overall || 0) - Number(a?.scores?.overall || 0));
  const lines = sliceMapWithOverflow(sortedCharacters, 12, (character, index) => {
    const logs = Number(character?.stats?.encounters) || 0;
    // Per-character class icon (each row is one char = one class, so the icon
    // is meaningful here); falls back to the role weapon emoji. Renders because
    // this is a plain field value, not a code block.
    const icon = getClassEmoji(character.class) || roleEmoji(character);
    // Flex chars (a second scored build) are tagged `flex·<primary role>`; the
    // full both-build breakdown lives in the CHARACTER detail view.
    const roleTag = character.altBuild
      ? t("raidProfile.labels.flexRole", lang, { role: roleTagForBuild(character.role, lang) })
      : roleLabel(character, lang);
    return `\`${index + 1}.\` ${icon} **${character.name}** \`${roleTag}\` · ${t("raidProfile.lines.scoredLogs", lang, { logs })} · ${t("raidProfile.labels.scoreMvp", lang)} ${score(character?.scores?.mvp)} · **${score(character?.scores?.overall)}**`;
  });
  embed.addFields({
    name: hudFieldName(t("raidProfile.sections.character", lang)),
    value: lines.length ? lines.join("\n") : t("raidProfile.noChars", lang),
    inline: false,
  });
  embed.setFooter({
    text: footerText([
      entry.isOwn ? t("raidProfile.owner.own", lang) : t("raidProfile.owner.shared", lang),
      `${sourceTag(entry.source, lang)} · ${rangeTag(entry.rangeType, lang)}`,
      footerTimestamp(entry.receivedAt || entry.generatedAt, lang),
      t("raidProfile.footer.logCount", lang, { logs: agg.logs }),
      t("raidProfile.footer.scoredCount", lang, { scored: agg.scoredLogs }),
      t("raidProfile.footer.confidence", lang, { confidence: confidenceLabelForLogs(agg.scoredLogs, lang) }),
    ]),
  });

  return embed;
}

function buildCharacterEmbed({ EmbedBuilder }, session, entry, character) {
  const lang = session.lang || "vi";
  const isBibleSummary = isBibleSummaryProfile(entry, character);
  const spec = buildSpecName(character.build, character.build?.spec || "");
  const altBuild = character.altBuild || null;
  const displayBuilds = buildDisplayBuilds(character);
  const primaryDisplay = displayBuilds[0] || {};
  const roleTag = altBuild ? t("raidProfile.labels.flex", lang) : roleTagForBuild(primaryDisplay.role || character.role, lang);
  const totalLogs = totalCharacterLogs(character);
  const classEmoji = getClassEmoji(character.class) || (primaryDisplay.role === "support" ? "🛡️" : "⚔️");

  const embed = new EmbedBuilder()
    .setColor(primaryDisplay.role === "support" && !altBuild ? PROFILE_COLORS.support : PROFILE_COLORS.amber)
    .setAuthor({ name: t("raidProfile.author.character", lang, { character: String(character.name || "UNKNOWN").toUpperCase(), role: roleTag }) })
    .setTitle(`${classEmoji} ${character.name}`)
    .setDescription([
      `iLvl **${character.itemLevel || 0}**`,
      !altBuild && spec ? `\`${spec}\`` : null,
      `**${totalLogs}** log`,
      t("raidProfile.lines.confidence", lang, { confidence: confidenceLabelForLogs(totalLogs, lang) }),
    ].filter(Boolean).join(" · "));

  displayBuilds.forEach((build, index) => {
    if (altBuild) {
      const specLabel = build.spec ? ` · \`${build.spec}\`` : "";
      embed.addFields({
        name: hudFieldName(`${index === 0 ? t("raidProfile.sections.primaryBuild", lang) : t("raidProfile.sections.altBuild", lang)} · ${roleTagForBuild(build.role, lang)}`),
        value: `**${Math.round(Number(build.encounters) || 0)}** log${specLabel}`,
        inline: false,
      });
    }
    embed.addFields(...buildBuildFields(build.role, build.stats, build.scores, {
      build: build.build,
      isBibleSummary,
      lang,
    }));
  });

  embed.setFooter({
    text: footerText([
      `${sourceTag(entry.source, lang)} · ${rangeTag(entry.rangeType, lang)}`,
      String(character.class || "UNKNOWN").toUpperCase(),
      roleTag,
      t("raidProfile.footer.scoredCount", lang, { scored: totalLogs }),
      t("raidProfile.footer.confidence", lang, { confidence: confidenceLabelForLogs(totalLogs, lang) }),
    ]),
  });

  return embed;
}

module.exports = {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
};
