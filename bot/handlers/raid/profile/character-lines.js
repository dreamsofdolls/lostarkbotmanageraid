"use strict";

const { t } = require("../../../services/i18n");
const {
  attackStyleLabel,
  bibleOutputLines,
  burstProfileLines,
  formatDateMs,
  formatDurationMs,
  pct,
  rangeLabel,
  ratePct,
  renderGauge,
  renderPercentGauge,
  score,
  scoreLine,
  shortNumber,
} = require("./view-helpers");

function roleDetailLines(stats, scores, { isSupport, isBibleSummary }) {
  if (isBibleSummary) return bibleOutputLines(stats, scores, isSupport);
  if (isSupport) {
    return [
      scoreLine("rDPS impact", scores.supportUptime),
      scoreLine("Raid contribution", scores.raidContribution),
      scoreLine("Protection", scores.protection),
      `Shield/min: **${shortNumber(stats.avgProtectionPerMinute)}**`,
      `rDPS given/min: **${shortNumber(stats.avgRdpsDamageGivenPerMinute)}**`,
      `Supporter: **${pct(stats.avgSupporterPercent)}** · Radiant ${pct(stats.radiantSupportRate)}`,
      `Support rank: **${stats.supporterRankValidCount ? `${score(stats.avgSupporterRank)}/${score(stats.supporterCountAvg)}` : "N/A"}** · top ${pct(stats.supporterTopRate)}`,
      `Context pct: **${pct(stats.avgContextSupportPercentile || stats.avgContextPerformancePercentile)}** · cover ${pct(stats.contextCoverageRate)} n~${Math.round(Number(stats.contextSampleCountAvg) || 0)}`,
      `Synergy/min: **${shortNumber(stats.avgSynergyGivenPerMinute)}**`,
      `AP/Brand: ${ratePct(stats.avgSupportAp)} / ${ratePct(stats.avgSupportBrand)}`,
      `Identity/Hyper: ${ratePct(stats.avgSupportIdentity)} / ${ratePct(stats.avgSupportHyper)}`,
    ];
  }
  return [
    `Avg DPS: **${shortNumber(stats.avgDps)}**`,
    `Median DPS: **${shortNumber(stats.medianDps)}**`,
    ...burstProfileLines(stats),
    `Damage share: **${pct(stats.avgDamageShare)}** · ${renderGauge(scores.damageShare)}`,
    `Top proximity: **${pct(stats.avgTopDamageProximity)}**`,
    `Context pct: **${pct(stats.avgContextPerformancePercentile)}** · cover ${pct(stats.contextCoverageRate)} n~${Math.round(Number(stats.contextSampleCountAvg) || 0)}`,
    `Top rate: **${pct(stats.topRate)}**`,
  ];
}

function sourceOrCombatShapeLines(entry, stats, { isBibleSummary }) {
  if (isBibleSummary) {
    return [
      "Data depth: **lostark.bible summary**",
      "Local-only metrics such as skills, buffs, rDPS share, damage taken, and support radiant rank need encounters.db sync.",
      `Profile range: **${rangeLabel(entry)}** · min duration **3m+**`,
      `Last fight: ${formatDateMs(stats.lastFightStart)}`,
    ];
  }
  return [
    `Style: **${attackStyleLabel(stats.attackStyle)}**`,
    `Crit: **${pct(stats.avgCritRate)}**`,
    `Back/Front: ${pct(stats.avgBackAttackRate)} / ${pct(stats.avgFrontAttackRate)}`,
    `Damage crit/pos: **${pct(stats.avgCritDamageShare)}** · ${pct(stats.avgPositionalDamageShare)}`,
    `Damage back/front: ${pct(stats.avgBackAttackDamageShare)} / ${pct(stats.avgFrontAttackDamageShare)}`,
    `Hyper share: **${pct(stats.avgHyperShare)}**`,
    `Skills/top share: **${score(stats.avgSkillCount)}** / ${pct(stats.avgTopSkillShare)}`,
    `SUP buff/debuff: ${pct(stats.avgSupportBuffedShare)} / ${pct(stats.avgSupportDebuffedShare)}`,
  ];
}

function reliabilityLines(stats, { isBibleSummary, lang }) {
  const common = [
    `Deathless: ${renderPercentGauge(stats.deathlessRate)}`,
    `Death rate: **${pct(stats.deathRate)}**`,
    `Deaths: **${Math.round(Number(stats.totalDeaths) || 0)}** total · avg ${score(stats.avgDeaths)}`,
  ];
  if (isBibleSummary) {
    return [
      ...common,
      `Active time: avg **${formatDurationMs(stats.avgDurationMs)}**`,
      `${t("raidProfile.lastFight", lang)}: ${formatDateMs(stats.lastFightStart)}`,
    ];
  }
  return [
    ...common,
    `Dead time: **${formatDurationMs(stats.totalDeadTimeMs)}** total - avg ${formatDurationMs(stats.avgDeadTimeMs)}`,
    `Active time: avg **${formatDurationMs(stats.avgActiveDurationMs || stats.avgDurationMs)}** · ${pct(stats.avgActiveTimeRate || 100)}`,
    `rDPS valid: **${pct(stats.rdpsValidRate)}** (${Math.round(Number(stats.rdpsValidCount) || 0)}/${Math.round(Number(stats.encounters) || 0)})`,
    `Avg rank: **${score(stats.avgRank)}**`,
    `Counters/Stagger: **${score(stats.avgCounters)}** / ${shortNumber(stats.avgStaggerPerMinute)}/min`,
    `Taken: ${shortNumber(stats.avgDamageTakenPerMinute)}/min · share ${pct(stats.avgDamageTakenShare)}`,
    `Shielded: ${shortNumber(stats.avgShieldReceivedPerMinute)}/min`,
    `Incap: **${score(stats.avgIncapacitations)}** avg`,
    `${t("raidProfile.lastFight", lang)}: ${formatDateMs(stats.lastFightStart)}`,
  ];
}

module.exports = {
  reliabilityLines,
  roleDetailLines,
  sourceOrCombatShapeLines,
};
