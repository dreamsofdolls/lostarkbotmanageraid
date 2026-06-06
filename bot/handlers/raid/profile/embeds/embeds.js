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
  confidenceForLogs,
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

function roleTagForBuild(role) {
  return role === "support" ? "SUP" : "DPS";
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
  const header = `${"#".padStart(2)} ${"ROSTER NAME".padEnd(NAME_W)} ${"CHAR".padStart(4)} ${"LOG".padStart(5)}  ${"SCORE".padStart(5)}`;
  const rows = ranked.slice(0, CAP).map(({ entry, agg }, index) => {
    return `${String(index + 1).padStart(2)} ${fitName(getEntryLabel(entry))} ${String(agg.charCount).padStart(4)} ${String(agg.logs).padStart(5)}  ${score(agg.overall).padStart(5)}`;
  });
  if (entries.length > CAP) {
    rows.push(`   +${entries.length - CAP} roster…`);
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
      name: `// RAID PROFILE · OVERALL · ${session.entries.length} ROSTER · ${agg.charCount} CHAR`,
    })
    .setTitle(t("raidProfile.overallTitle", lang))
    .addFields(
      {
        name: hudFieldName("scope"),
        value: [
          `Log / scored: **${agg.logs} / ${agg.scoredLogs}**`,
          `${t("raidProfile.lastFight", lang)}: ${formatDateMs(agg.lastFightStart)}`,
          topOverall
            ? `★ top: ${getClassEmoji(topOverall.class) || roleEmoji(topOverall)} **${topOverall.name}** ${score(topOverall.scores.overall)}`
            : "★ top: **N/A**",
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("aggregate"),
        value: [
          scoreLine("Ov", agg.overall),
          scoreLine("MVP", agg.mvp),
          agg.dpsCount ? scoreLine("DPS", agg.dpsOverall) : "DPS: **N/A**",
          agg.supportCount ? scoreLine("SUP", agg.supportOverall) : "SUP: **N/A**",
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("roster"),
        value: buildRosterTable(session.entries, lang),
        inline: false,
      }
    );

  embed.setFooter({
    text: `// ${sourceSummaryForEntries(session.entries)} · ${footerTimestamp(latestSnapshotMs(session.entries))} · ${agg.logs} LOG · ${agg.scoredLogs} SCORED · CONF ${confidenceForLogs(agg.scoredLogs).toUpperCase()}`,
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
      name: `// RAID PROFILE · ROSTER · ${String(entry.accountName || "").toUpperCase()} · ${agg.charCount} CHAR · ${entry.isOwn ? "OWN" : "SHARED"}`,
    })
    .setTitle(t("raidProfile.rosterTitle", lang, { account: entry.accountName }))
    .setDescription(metaLine)
    .addFields(
      {
        name: hudFieldName("scope"),
        value: [
          `Log / scored: **${agg.logs} / ${agg.scoredLogs}**`,
          scoreLine("Ov", agg.overall),
          scoreLine("MVP", agg.mvp),
        ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName("role split"),
        value: [
          `DPS: **${agg.dpsCount}** · ${agg.dpsCount ? score(agg.dpsOverall) : "N/A"}`,
          `SUP: **${agg.supportCount}** · ${agg.supportCount ? score(agg.supportOverall) : "N/A"}`,
          topOverall
            ? `★ top: ${getClassEmoji(topOverall.class) || roleEmoji(topOverall)} **${topOverall.name}** ${score(topOverall.scores.overall)}`
            : "★ top: N/A",
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
      ? `flex·${character.role === "support" ? "SUP" : "DPS"}`
      : roleLabel(character);
    return `\`${index + 1}.\` ${icon} **${character.name}** \`${roleTag}\` · ${logs} scored · MVP ${score(character?.scores?.mvp)} · **${score(character?.scores?.overall)}**`;
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
  const isBibleSummary = isBibleSummaryProfile(entry, character);
  const spec = buildSpecName(character.build, character.build?.spec || "");
  const altBuild = character.altBuild || null;
  const displayBuilds = buildDisplayBuilds(character);
  const primaryDisplay = displayBuilds[0] || {};
  const roleTag = altBuild ? "FLEX" : roleTagForBuild(primaryDisplay.role || character.role);
  const totalLogs = totalCharacterLogs(character);
  const classEmoji = getClassEmoji(character.class) || (primaryDisplay.role === "support" ? "🛡️" : "⚔️");

  const embed = new EmbedBuilder()
    .setColor(primaryDisplay.role === "support" && !altBuild ? PROFILE_COLORS.support : PROFILE_COLORS.amber)
    .setAuthor({ name: `// RAID PROFILE · CHARACTER · ${String(character.name || "UNKNOWN").toUpperCase()} · ${roleTag}` })
    .setTitle(`${classEmoji} ${character.name}`)
    .setDescription([
      `iLvl **${character.itemLevel || 0}**`,
      !altBuild && spec ? `\`${spec}\`` : null,
      `**${totalLogs}** log`,
      `CONF **${confidenceForLogs(totalLogs).toUpperCase()}**`,
    ].filter(Boolean).join(" · "));

  displayBuilds.forEach((build, index) => {
    if (altBuild) {
      const specLabel = build.spec ? ` · \`${build.spec}\`` : "";
      embed.addFields({
        name: `// ${index === 0 ? "PRIMARY" : "ALT BUILD"} · ${roleTagForBuild(build.role)} BUILD`,
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
    text: `// ${sourceTag(entry.source)} ${rangeTag(entry.rangeType)} · ${String(character.class || "UNKNOWN").toUpperCase()} · ${roleTag} · ${totalLogs} SCORED · CONF ${confidenceForLogs(totalLogs).toUpperCase()}`,
  });

  return embed;
}

module.exports = {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
};
