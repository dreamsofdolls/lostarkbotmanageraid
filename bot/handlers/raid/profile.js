"use strict";

const { randomUUID } = require("node:crypto");
const { getAccessibleAccounts } = require("../../services/access/access-control");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const { getClassEmoji } = require("../../models/Class");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");

const PROFILE_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SELECT_OPTIONS = 25;
const MAX_CHARACTER_SELECT_OPTIONS = MAX_SELECT_OPTIONS - 1;
const ROSTER_PAGE_SIZE = MAX_SELECT_OPTIONS - 1;
const profileSessions = new Map();

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function shortNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";
}

function shortLabel(value, max = 28) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function sourceSummary(sources, limit = 3) {
  const lines = [...(sources || [])]
    .filter((source) => source?.name)
    .slice(0, limit)
    .map((source) => `${shortLabel(source.name)} ${pct(source.share)}`);
  return lines.length ? lines.join(", ") : "N/A";
}

function engravingSummary(engravings, limit = 5) {
  const lines = [...(engravings || [])]
    .filter((engraving) => engraving?.name)
    .slice(0, limit)
    .map((engraving) => `${shortLabel(engraving.name, 22)} ${engraving.level || 0}`);
  return lines.length ? lines.join(", ") : "N/A";
}

function arkPassiveSummary(arkPassive) {
  if (!arkPassive) return "N/A";
  const evolution = Number(arkPassive.evolution?.points) || 0;
  const enlightenment = Number(arkPassive.enlightenment?.points) || 0;
  const leap = Number(arkPassive.leap?.points) || 0;
  if (!evolution && !enlightenment && !leap) return "N/A";
  return `Evo ${evolution} / Enl ${enlightenment} / Leap ${leap}`;
}

function arkPassiveNodeSummary(nodes, limit = 5) {
  const entries = [...(nodes || [])]
    .filter((node) => node?.id)
    .slice(0, limit)
    .map((node) => {
      const name = shortLabel(node.name || `#${node.id}`, 26);
      const level = Math.round(Number(node.level) || 0);
      return level ? `${name} Lv.${level}` : name;
    });
  if (!entries.length) return "N/A";
  const extra = Math.max(0, (nodes || []).length - entries.length);
  return extra ? `${entries.join(", ")} (+${extra})` : entries.join(", ");
}

function enlightenmentSummary(arkPassive, fallbackSpec) {
  const tree = arkPassive?.enlightenment;
  if (!tree) return "N/A";
  const spec = shortLabel(tree.spec || fallbackSpec || "", 30);
  const nodes = arkPassiveNodeSummary(tree.nodes);
  if (spec && nodes !== "N/A") return `**${spec}** - ${nodes}`;
  if (spec) return `**${spec}**`;
  return nodes;
}

function ratePct(value) {
  const n = Number(value) || 0;
  const normalized = n > 1 ? n / 100 : n;
  return pct(Math.max(0, Math.min(1, normalized)) * 100);
}

function attackStyleLabel(value) {
  if (value === "back") return "Back Attack";
  if (value === "front") return "Front Attack";
  return "Hit Master";
}

function roleLabel(character) {
  if (character?.classRole === "support" && character?.role === "dps") return "DPS build";
  if (character?.role === "support") return "SUP";
  if (character?.role === "dps") return "DPS";
  return "Unknown";
}

function roleEmoji(character) {
  return character?.role === "support" ? "🛡️" : "⚔️";
}

function score(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function renderGauge(value, { suffix = "" } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "`▱▱▱▱▱▱▱▱▱▱` **N/A**";
  const clamped = Math.max(0, Math.min(100, n));
  const filled = Math.round(clamped / 10);
  const empty = Math.max(0, 10 - filled);
  return `\`${"▰".repeat(filled)}${"▱".repeat(empty)}\` **${score(n)}${suffix}**`;
}

function renderPercentGauge(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "`▱▱▱▱▱▱▱▱▱▱` **N/A**";
  return renderGauge(Math.max(0, Math.min(100, n)), { suffix: "%" });
}

function scoreLine(label, value) {
  return `${label}: ${renderGauge(value)}`;
}

function hudFieldName(label) {
  return `// ${String(label || "").trim().toUpperCase()}`;
}

function latestSnapshotMs(entries) {
  return Math.max(0, ...(entries || []).map((entry) => Number(entry?.receivedAt || entry?.generatedAt) || 0));
}

function footerTimestamp(ms) {
  const n = Number(ms) || 0;
  if (!n) return "SNAPSHOT N/A";
  return `SNAPSHOT ${new Date(n).toISOString().replace(".000Z", "Z")}`;
}

function formatDateMs(ms) {
  const n = Number(ms) || 0;
  if (!n) return "chưa có";
  return `<t:${Math.floor(n / 1000)}:R>`;
}

function formatDurationMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return "0s";
  const totalSeconds = Math.round(n / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function confidenceForLogs(logs) {
  const n = Number(logs) || 0;
  if (n >= 20) return "High";
  if (n >= 5) return "Medium";
  return "Low";
}

function isBibleSummaryProfile(entry, character = null) {
  return entry?.source === "bible" || character?.stats?.profileDataDepth === "bible-summary";
}

function sourceTag(source) {
  return source === "bible" ? "BIBLE" : "LOCAL";
}

function rangeTag(rangeType) {
  return rangeType === "weekly" ? "WEEKLY" : "FULL";
}

function rangeLabel(entry) {
  return entry?.rangeType === "weekly" ? "weekly" : "full";
}

function sourceSummaryForEntries(entries) {
  const tags = [...new Set((entries || []).map((entry) => sourceTag(entry?.source)))];
  return tags.length ? tags.join("+") : "N/A";
}

function contextScoreLine(entry, character) {
  const stats = character?.stats || {};
  const scores = character?.scores || {};
  if (isBibleSummaryProfile(entry, character)) {
    return scoreLine("Bible pct", scores.context);
  }
  const coverage = Number(stats.contextCoverageRate) || 0;
  const sampleCount = Number(stats.contextSampleCountAvg) || 0;
  const contextScore = Number(scores.context);
  if (coverage > 0 || sampleCount > 0 || Number.isFinite(contextScore) && contextScore > 0) {
    return scoreLine("Context", scores.context);
  }
  return "Context: **N/A**";
}

function burstProfileLines(stats) {
  const peak = Number(stats?.avgPeak10sDps) || 0;
  if (peak <= 0) return [];
  const p90Peak = Number(stats?.p90Peak10sDps) || 0;
  const ratio = Number(stats?.avgBurstRatio) || 0;
  return [`Peak 10s: **${shortNumber(peak)}** - p90 ${shortNumber(p90Peak)} - burst x${score(ratio)}`];
}

function bibleOutputLines(stats, scores, isSupport = false) {
  const lines = [
    `Bible pct: **${pct(stats.avgBiblePercentile)}** · overall ${pct(stats.avgOverallBiblePercentile)} · cover ${pct(stats.biblePercentileCoverageRate)}`,
    `Avg DPS: **${shortNumber(stats.avgDps)}** · median ${shortNumber(stats.medianDps)} · p90 ${shortNumber(stats.p90Dps)}`,
  ];
  if (Number(stats.avgRdps) > 0 || Number(stats.avgNdps) > 0) {
    lines.push(`rDPS/nDPS: **${shortNumber(stats.avgRdps)}** / ${shortNumber(stats.avgNdps)}`);
  }
  if (Number(stats.avgUdps) > 0) {
    lines.push(`uDPS: **${shortNumber(stats.avgUdps)}**`);
  }
  if (isSupport && Number(stats.supportBuffCoverageRate) > 0) {
    lines.push(`AP/Brand: ${ratePct(stats.avgSupportAp)} / ${ratePct(stats.avgSupportBrand)}`);
    lines.push(`Identity/Hyper: ${ratePct(stats.avgSupportIdentity)} / ${ratePct(stats.avgSupportHyper)}`);
  }
  lines.push(`Duration: avg **${formatDurationMs(stats.avgDurationMs)}**`);
  lines.push(`Bus logs: **${Math.round(Number(stats.busCount) || 0)}** (${pct(stats.busRate)})`);
  lines.push(`Source confidence: **${pct(scores.sourceConfidence)}**`);
  return lines;
}

function buildVariantSummary(variants, { limit = 4 } = {}) {
  const lines = [...(variants || [])]
    .filter((variant) => variant?.name)
    .sort((a, b) =>
      Number(b?.encounters || 0) - Number(a?.encounters || 0) ||
      Number(b?.lastFightStart || 0) - Number(a?.lastFightStart || 0)
    )
    .slice(0, limit)
    .map((variant) => {
      const pctText = Number(variant.avgOverallBiblePercentile || variant.avgBiblePercentile || variant.avgContextPerformancePercentile) > 0
        ? ` · pct ${pct(variant.avgOverallBiblePercentile || variant.avgBiblePercentile || variant.avgContextPerformancePercentile)}`
        : "";
      return `${shortLabel(variant.name, 22)} ${Math.round(Number(variant.encounters) || 0)} log · DPS ${shortNumber(variant.medianDps || variant.avgDps)}${pctText}`;
    });
  return lines.length ? lines.join("\n") : "N/A";
}

function charWeight(character) {
  const logs = Number(character?.stats?.encounters) || 0;
  if (logs >= 20) return 1;
  if (logs >= 5) return 0.8;
  if (logs > 0) return 0.5;
  return 0;
}

function weightedAverage(chars, pick) {
  let total = 0;
  let weightTotal = 0;
  for (const character of chars) {
    const w = charWeight(character);
    const value = Number(pick(character));
    if (!w || !Number.isFinite(value)) continue;
    total += value * w;
    weightTotal += w;
  }
  return weightTotal > 0 ? total / weightTotal : 0;
}

function flattenCharacters(entries) {
  const chars = [];
  for (const entry of entries || []) {
    for (const character of entry.characters || []) {
      chars.push({ ...character, _profileEntry: entry });
    }
  }
  return chars;
}

function aggregateCharacters(chars) {
  const list = Array.isArray(chars) ? chars : [];
  const dpsChars = list.filter((c) => c.role !== "support");
  const supportChars = list.filter((c) => c.role === "support");
  const scoredLogs = list.reduce((sum, c) => sum + (Number(c?.stats?.encounters) || 0), 0);
  const logs = list.reduce((sum, c) => sum + (Number(c?.stats?.allEncounterCount) || Number(c?.stats?.encounters) || 0), 0);
  const lastFightStart = Math.max(0, ...list.map((c) => Number(c?.stats?.lastFightStart) || 0));
  return {
    charCount: list.length,
    logs,
    scoredLogs,
    lastFightStart,
    overall: weightedAverage(list, (c) => c?.scores?.overall),
    mvp: weightedAverage(list, (c) => c?.scores?.mvp),
    dpsOverall: weightedAverage(dpsChars, (c) => c?.scores?.overall),
    supportOverall: weightedAverage(supportChars, (c) => c?.scores?.overall),
    dpsCount: dpsChars.length,
    supportCount: supportChars.length,
  };
}

function pickTopChar(chars, scoreKey = "overall") {
  return [...(chars || [])]
    .filter((c) => Number(c?.scores?.[scoreKey]) > 0)
    .sort((a, b) => Number(b.scores[scoreKey]) - Number(a.scores[scoreKey]))[0] || null;
}

function getEntryLabel(entry) {
  if (entry.isOwn) return entry.accountName;
  return `${entry.ownerLabel || entry.ownerDiscordId} / ${entry.accountName}`;
}

function snapshotHasCharacters(snapshot) {
  return (snapshot?.accounts || []).some((account) =>
    Array.isArray(account?.characters) && account.characters.length > 0
  );
}

function snapshotDataRank(snapshot) {
  if (!snapshotHasCharacters(snapshot)) return 0;
  const source = snapshot?.source || "";
  const criteriaSource = snapshot?.criteria?.source || "";
  const dataDepth = snapshot?.criteria?.dataDepth || "";
  if (source === "local" || criteriaSource === "encounters.db") return 3;
  if (source === "bible" || criteriaSource === "lostark.bible" || dataDepth === "bible-summary") return 1;
  return 2;
}

function shouldUseFullSnapshot(root, full) {
  if (!snapshotHasCharacters(full)) return false;
  if (!snapshotHasCharacters(root)) return true;
  const rootRank = snapshotDataRank(root);
  const fullRank = snapshotDataRank(full);
  if (fullRank < rootRank) return false;
  if (fullRank > rootRank) return true;
  const rootRange = root?.rangeType || root?.criteria?.range?.type || "full";
  const fullRange = full?.rangeType || full?.criteria?.range?.type || "full";
  return fullRange === "full" && rootRange !== "full";
}

function preferredSnapshotView(snapshot) {
  const full = snapshot?.rangeSnapshots?.full;
  if (shouldUseFullSnapshot(snapshot, full)) {
    return {
      ...snapshot,
      ...full,
      discordId: snapshot.discordId,
      rangeSnapshots: snapshot.rangeSnapshots,
    };
  }
  return snapshot;
}

async function buildAccessibleProfileEntries(viewerDiscordId, { RaidProfileSnapshot }) {
  const accessible = await getAccessibleAccounts(viewerDiscordId, { includeOwn: true });
  if (!accessible.length) return { accessible, entries: [] };

  const ownerIds = [...new Set(accessible.map((entry) => entry.ownerDiscordId).filter(Boolean))];
  const snapshots = await RaidProfileSnapshot.find({ discordId: { $in: ownerIds } }).lean();
  const snapshotByOwner = new Map(snapshots.map((snapshot) => [snapshot.discordId, preferredSnapshotView(snapshot)]));
  const entries = [];

  for (const access of accessible) {
    const snapshot = snapshotByOwner.get(access.ownerDiscordId);
    if (!snapshot) continue;
    const account = (snapshot.accounts || []).find(
      (item) => normalizeName(item.accountName) === normalizeName(access.accountName)
    );
    if (!account || !Array.isArray(account.characters) || account.characters.length === 0) continue;
    entries.push({
      ownerDiscordId: access.ownerDiscordId,
      ownerLabel: access.ownerLabel,
      accessLevel: access.accessLevel,
      isOwn: !!access.isOwn,
      accountName: account.accountName || access.accountName,
      generatedAt: snapshot.generatedAt,
      receivedAt: snapshot.receivedAt,
      source: snapshot.source || "local",
      rangeType: snapshot.rangeType || snapshot.criteria?.range?.type || "full",
      characters: account.characters,
    });
  }

  return { accessible, entries };
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

  const rosterLines = session.entries.slice(0, 10).map((entry, index) => {
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

  const lines = [...entry.characters]
    .sort((a, b) => Number(b?.scores?.overall || 0) - Number(a?.scores?.overall || 0))
    .slice(0, 12)
    .map((character, index) => {
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
        value: isBibleSummary
          ? bibleOutputLines(stats, scores, isSupport).join("\n")
          : isSupport
          ? [
              scoreLine("rDPS impact", scores.supportUptime),
              scoreLine("Raid contribution", scores.raidContribution),
              scoreLine("Protection", scores.protection),
              `Shield/min: **${shortNumber(stats.avgProtectionPerMinute)}**`,
              `rDPS given/min: **${shortNumber(stats.avgRdpsDamageGivenPerMinute)}**`,
              `Supporter: **${pct(stats.avgSupporterPercent)}** · Radiant ${pct(stats.radiantSupportRate)}`,
              `Support rank: **${stats.supporterRankValidCount ? `${score(stats.avgSupporterRank)}/${score(stats.supporterCountAvg)}` : "N/A"}** · top ${pct(stats.supporterTopRate)}`,
              `Context pct: **${pct(stats.avgContextSupportPercentile || stats.avgContextPerformancePercentile)}** · cover ${pct(stats.contextCoverageRate)} n~${score(stats.contextSampleCountAvg)}`,
              `Synergy/min: **${shortNumber(stats.avgSynergyGivenPerMinute)}**`,
              `AP/Brand: ${ratePct(stats.avgSupportAp)} / ${ratePct(stats.avgSupportBrand)}`,
              `Identity/Hyper: ${ratePct(stats.avgSupportIdentity)} / ${ratePct(stats.avgSupportHyper)}`,
            ].join("\n")
          : [
              `Avg DPS: **${shortNumber(stats.avgDps)}**`,
              `Median DPS: **${shortNumber(stats.medianDps)}**`,
              ...burstProfileLines(stats),
              `Damage share: **${pct(stats.avgDamageShare)}** · ${renderGauge(scores.damageShare)}`,
              `Top proximity: **${pct(stats.avgTopDamageProximity)}**`,
              `Context pct: **${pct(stats.avgContextPerformancePercentile)}** · cover ${pct(stats.contextCoverageRate)} n~${score(stats.contextSampleCountAvg)}`,
              `Top rate: **${pct(stats.topRate)}**`,
            ].join("\n"),
        inline: true,
      },
      {
        name: hudFieldName(isBibleSummary ? "source detail" : "combat shape"),
        value: isBibleSummary
          ? [
              "Data depth: **lostark.bible summary**",
              "Local-only metrics such as skills, buffs, rDPS share, damage taken, and support radiant rank need encounters.db sync.",
              `Profile range: **${rangeLabel(entry)}** · min duration **3m+**`,
              `Last fight: ${formatDateMs(stats.lastFightStart)}`,
            ].join("\n")
          : [
              `Style: **${attackStyleLabel(stats.attackStyle)}**`,
              `Crit: **${pct(stats.avgCritRate)}**`,
              `Back/Front: ${pct(stats.avgBackAttackRate)} / ${pct(stats.avgFrontAttackRate)}`,
              `Damage crit/pos: **${pct(stats.avgCritDamageShare)}** · ${pct(stats.avgPositionalDamageShare)}`,
              `Damage back/front: ${pct(stats.avgBackAttackDamageShare)} / ${pct(stats.avgFrontAttackDamageShare)}`,
              `Hyper share: **${pct(stats.avgHyperShare)}**`,
              `Skills/top share: **${score(stats.avgSkillCount)}** / ${pct(stats.avgTopSkillShare)}`,
              `SUP buff/debuff: ${pct(stats.avgSupportBuffedShare)} / ${pct(stats.avgSupportDebuffedShare)}`,
            ].join("\n"),
        inline: false,
      },
      {
        name: hudFieldName("reliability"),
        value: isBibleSummary
          ? [
              `Deathless: ${renderPercentGauge(stats.deathlessRate)}`,
              `Death rate: **${pct(stats.deathRate)}**`,
              `Deaths: **${Math.round(Number(stats.totalDeaths) || 0)}** total · avg ${score(stats.avgDeaths)}`,
              `Active time: avg **${formatDurationMs(stats.avgDurationMs)}**`,
              `${t("raidProfile.lastFight", lang)}: ${formatDateMs(stats.lastFightStart)}`,
            ].join("\n")
          : [
              `Deathless: ${renderPercentGauge(stats.deathlessRate)}`,
              `Death rate: **${pct(stats.deathRate)}**`,
              `Deaths: **${Math.round(Number(stats.totalDeaths) || 0)}** total · avg ${score(stats.avgDeaths)}`,
              `Dead time: **${formatDurationMs(stats.totalDeadTimeMs)}** total - avg ${formatDurationMs(stats.avgDeadTimeMs)}`,
              `Active time: avg **${formatDurationMs(stats.avgActiveDurationMs || stats.avgDurationMs)}** · ${pct(stats.avgActiveTimeRate || 100)}`,
              `rDPS valid: **${pct(stats.rdpsValidRate)}** (${Math.round(Number(stats.rdpsValidCount) || 0)}/${Math.round(Number(stats.encounters) || 0)})`,
              `Avg rank: **${score(stats.avgRank)}**`,
              `Counters/Stagger: **${score(stats.avgCounters)}** / ${shortNumber(stats.avgStaggerPerMinute)}/min`,
              `Taken: ${shortNumber(stats.avgDamageTakenPerMinute)}/min · share ${pct(stats.avgDamageTakenShare)}`,
              `Shielded: ${shortNumber(stats.avgShieldReceivedPerMinute)}/min`,
              `Incap: **${score(stats.avgIncapacitations)}** avg`,
              `${t("raidProfile.lastFight", lang)}: ${formatDateMs(stats.lastFightStart)}`,
            ].join("\n"),
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
        `CP: **${build.combatPower ? score(build.combatPower) : "N/A"}**`,
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

  const skillLines = [...(character.topSkills || [])]
    .slice(0, 5)
    .map((skill, index) => (
      `\`${index + 1}.\` **${skill.name || "Unknown"}** · ${renderPercentGauge(skill.share)} · crit ${pct(skill.critRate)}`
    ));
  if (skillLines.length) {
    embed.addFields({
      name: hudFieldName("top skills"),
      value: skillLines.join("\n"),
      inline: false,
    });
  }

  const raidLines = [...(character.raids || [])]
    .sort((a, b) => Number(b?.encounters || 0) - Number(a?.encounters || 0))
    .slice(0, 8)
    .map((raid) => {
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

function selectOption(label, value, description, emoji, isDefault = false) {
  const option = {
    label: label.slice(0, 100) || "Unknown",
    value,
    default: isDefault,
  };
  if (description) option.description = description.slice(0, 100);
  if (emoji) option.emoji = emoji;
  return option;
}

function clampPage(page, totalItems, pageSize) {
  const maxPage = Math.max(0, Math.ceil(Math.max(0, totalItems) / pageSize) - 1);
  const n = Number(page) || 0;
  return Math.max(0, Math.min(maxPage, Math.floor(n)));
}

function buildComponents(deps, session) {
  const {
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = deps;
  const sid = session.id;
  const lang = session.lang || "vi";
  const selectedEntry = session.rosterIndex >= 0 ? session.entries[session.rosterIndex] : null;
  const selectedChar = selectedEntry && session.charIndex >= 0
    ? selectedEntry.characters[session.charIndex]
    : null;
  const rosterPage = selectedEntry
    ? Math.floor(session.rosterIndex / ROSTER_PAGE_SIZE)
    : clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
  const rosterPageStart = rosterPage * ROSTER_PAGE_SIZE;

  const rosterOptions = [
    selectOption(t("raidProfile.optOverall", lang), "overall", t("raidProfile.optOverallDesc", lang), "📊", session.rosterIndex < 0),
    ...session.entries.slice(rosterPageStart, rosterPageStart + ROSTER_PAGE_SIZE).map((entry, offset) => {
      const index = rosterPageStart + offset;
      const agg = aggregateCharacters(entry.characters);
      return selectOption(
        getEntryLabel(entry),
        String(index),
        `${entry.isOwn ? "Own" : "Shared"} · ${agg.charCount} char · ${agg.logs} log`,
        entry.isOwn ? "📁" : "👥",
        session.rosterIndex === index
      );
    }),
  ];

  const rosterRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:roster:${sid}`)
      .setPlaceholder(t("raidProfile.rosterPlaceholder", lang))
      .addOptions(rosterOptions)
  );

  const charPageStart = selectedEntry && session.charIndex >= 0
    ? Math.floor(session.charIndex / MAX_CHARACTER_SELECT_OPTIONS) * MAX_CHARACTER_SELECT_OPTIONS
    : 0;
  const charOptions = selectedEntry
    ? [
        selectOption(t("raidProfile.optRosterOverview", lang), "overview", t("raidProfile.optRosterOverviewDesc", lang), "📁", session.charIndex < 0),
        ...selectedEntry.characters.slice(charPageStart, charPageStart + MAX_CHARACTER_SELECT_OPTIONS).map((character, offset) => {
          const index = charPageStart + offset;
          return selectOption(
            character.name,
            String(index),
            `${roleLabel(character)} · ${character.stats?.encounters || 0} scored · score ${score(character.scores?.overall)}`,
            roleEmoji(character),
            session.charIndex === index
          );
        }),
      ]
    : [selectOption(t("raidProfile.optPickRosterFirst", lang), "disabled", t("raidProfile.optPickRosterFirstDesc", lang), "📁", true)];

  const charRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:char:${sid}`)
      .setPlaceholder(t("raidProfile.charPlaceholder", lang))
      .setDisabled(!selectedEntry)
      .addOptions(charOptions)
  );

  const canPageChars = !!selectedEntry && selectedEntry.characters.length > 0;
  const canPageRosters = !selectedEntry && session.entries.length > ROSTER_PAGE_SIZE;
  const canPage = canPageChars || canPageRosters;
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`raid-profile:prev:${sid}`)
      .setLabel(t("raidProfile.btnPrev", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage),
    new ButtonBuilder()
      .setCustomId(`raid-profile:overview:${sid}`)
      .setLabel(selectedChar ? t("raidProfile.btnRosterOverview", lang) : t("raidProfile.btnOverall", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selectedEntry),
    new ButtonBuilder()
      .setCustomId(`raid-profile:next:${sid}`)
      .setLabel(t("raidProfile.btnNext", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage)
  );

  return [rosterRow, charRow, buttonRow];
}

function renderSessionPayload(deps, session) {
  let embed;
  if (session.rosterIndex < 0) {
    embed = buildOverallEmbed(deps, session);
  } else {
    const entry = session.entries[session.rosterIndex];
    if (session.charIndex >= 0 && entry?.characters?.[session.charIndex]) {
      embed = buildCharacterEmbed(deps, session, entry, entry.characters[session.charIndex]);
    } else {
      embed = buildRosterEmbed(deps, session, entry);
    }
  }
  return {
    embeds: [embed],
    components: buildComponents(deps, session),
  };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of profileSessions) {
    if (session.expiresAt <= now) profileSessions.delete(id);
  }
}

function getSessionForInteraction(interaction) {
  cleanupSessions();
  const parts = String(interaction.customId || "").split(":");
  const sid = parts[2];
  const session = profileSessions.get(sid);
  if (!session) return { action: parts[1], session: null };
  if (session.viewerDiscordId !== interaction.user?.id) {
    return { action: parts[1], session: null, forbidden: true };
  }
  session.expiresAt = Date.now() + PROFILE_SESSION_TTL_MS;
  return { action: parts[1], session };
}

function createRaidProfileCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    RaidProfileSnapshot,
  } = deps;

  const renderDeps = { ...deps, EmbedBuilder, UI };

  async function handleRaidProfileCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const viewerDiscordId = interaction.user.id;
    const lang = await getUserLanguage(viewerDiscordId, { UserModel: User });
    const { accessible, entries } = await buildAccessibleProfileEntries(viewerDiscordId, {
      RaidProfileSnapshot,
    });

    if (!accessible.length) {
      const embed = buildNoticeEmbed(EmbedBuilder, {
        type: "info",
        title: t("raidProfile.noRosterTitle", lang),
        description: t("raidProfile.noRosterDesc", lang),
      }).setAuthor({ name: "// RAID PROFILE · HEADS UP" });
      await interaction.editReply({
        embeds: [embed],
      });
      return;
    }

    if (!entries.length) {
      const userDoc = await User.findOne({ discordId: viewerDiscordId })
        .select("autoManageEnabled localSyncEnabled lastLocalProfileSyncAt lastLocalSyncAt")
        .lean()
        .catch(() => null);
      let hint;
      if (userDoc?.localSyncEnabled) {
        hint = t("raidProfile.noSnapshotHintOn", lang);
      } else if (userDoc?.autoManageEnabled) {
        hint = t("raidProfile.noSnapshotHintBible", lang);
      } else {
        hint = t("raidProfile.noSnapshotHintOff", lang);
      }
      const embed = buildNoticeEmbed(EmbedBuilder, {
        type: "info",
        title: t("raidProfile.noSnapshotTitle", lang),
        description: hint,
      }).setAuthor({ name: "// RAID PROFILE · HEADS UP" });
      await interaction.editReply({
        embeds: [embed],
      });
      return;
    }

    const sid = randomUUID();
    const session = {
      id: sid,
      viewerDiscordId,
      lang,
      entries,
      rosterIndex: -1,
      rosterPage: 0,
      charIndex: -1,
      expiresAt: Date.now() + PROFILE_SESSION_TTL_MS,
    };
    profileSessions.set(sid, session);
    await interaction.editReply(renderSessionPayload(renderDeps, session));
  }

  async function handleRaidProfileComponent(interaction) {
    const { action, session, forbidden } = getSessionForInteraction(interaction);
    if (!session) {
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: forbidden ? t("raidProfile.forbiddenTitle", lang) : t("raidProfile.expiredTitle", lang),
            description: forbidden
              ? t("raidProfile.forbiddenDesc", lang)
              : t("raidProfile.expiredDesc", lang),
          }),
        ],
      });
      return;
    }

    if (interaction.isStringSelectMenu?.()) {
      const value = interaction.values?.[0] || "";
      if (action === "roster") {
        if (value === "overall") {
          session.rosterIndex = -1;
          session.charIndex = -1;
        } else {
          const idx = Number(value);
          if (Number.isInteger(idx) && session.entries[idx]) {
            session.rosterIndex = idx;
            session.rosterPage = Math.floor(idx / ROSTER_PAGE_SIZE);
            session.charIndex = -1;
          }
        }
      } else if (action === "char") {
        if (value === "overview") {
          session.charIndex = -1;
        } else {
          const idx = Number(value);
          const entry = session.entries[session.rosterIndex];
          if (Number.isInteger(idx) && entry?.characters?.[idx]) {
            session.charIndex = idx;
          }
        }
      }
      await interaction.update(renderSessionPayload(renderDeps, session));
      return;
    }

    if (interaction.isButton?.()) {
      const entry = session.entries[session.rosterIndex];
      if (action === "overview") {
        if (session.rosterIndex >= 0) session.charIndex = -1;
        else session.rosterIndex = -1;
      } else if (!entry && session.entries.length > ROSTER_PAGE_SIZE) {
        const totalPages = Math.ceil(session.entries.length / ROSTER_PAGE_SIZE);
        const current = clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
        if (action === "prev") session.rosterPage = (current - 1 + totalPages) % totalPages;
        if (action === "next") session.rosterPage = (current + 1) % totalPages;
      } else if (entry?.characters?.length) {
        const total = entry.characters.length;
        const current = session.charIndex >= 0 ? session.charIndex : 0;
        if (action === "prev") session.charIndex = (current - 1 + total) % total;
        if (action === "next") session.charIndex = (current + 1) % total;
      }
      await interaction.update(renderSessionPayload(renderDeps, session));
    }
  }

  return {
    handleRaidProfileCommand,
    handleRaidProfileComponent,
    __test: {
      aggregateCharacters,
      buildAccessibleProfileEntries,
      preferredSnapshotView,
      renderSessionPayload,
    },
  };
}

module.exports = {
  createRaidProfileCommand,
};
