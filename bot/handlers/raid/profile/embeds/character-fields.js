"use strict";

const { t } = require("../../../../services/i18n");
const { getRaidModeLabel } = require("../../../../utils/raid/common/labels");
const {
  arkPassiveSummary,
  buildVariantSummary,
  engravingSummary,
  enlightenmentSummary,
} = require("../helpers/view-helpers");
const {
  hudFieldName,
  pct,
  renderPercentGauge,
  roleLabel,
  shortNumber,
  sourceSummary,
} = require("../helpers/display");
const {
  sliceMapWithOverflow,
} = require("../helpers/list-lines");

function buildRoleDetectionField(character, stats) {
  if (character.classRole !== "support") return null;
  return {
    name: hudFieldName("role detection"),
    value: [
      `Class role: **SUP** · scored as **${roleLabel(character)}**`,
      `SUP logs: **${Math.round(Number(stats.supportLogCount) || 0)}** (${pct(stats.supportLogRate)})`,
      `DPS-build logs: **${Math.round(Number(stats.dpsBuildLogCount) || 0)}** (${pct(stats.dpsBuildLogRate)})`,
      `Used for score: **${Math.round(Number(stats.encounters) || 0)} / ${Math.round(Number(stats.allEncounterCount) || Number(stats.encounters) || 0)}** (${pct(stats.primaryRoleRate || 100)})`,
    ].join("\n"),
    inline: false,
  };
}

function buildBuffProfileField(character, stats, { isBibleSummary }) {
  if (isBibleSummary) return null;
  return {
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
  };
}

function hasBuildDetails(build, character) {
  return Boolean(
    build.spec ||
    build.gearScore ||
    build.combatPower ||
    build.engravings?.length ||
    build.arkPassive ||
    character.buildVariants?.length
  );
}

function buildBuildField(character, stats) {
  const build = character.build || {};
  if (!hasBuildDetails(build, character)) return null;
  return {
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
  };
}

function buildTopSkillsField(character) {
  const skillLines = sliceMapWithOverflow(character.topSkills || [], 5, (skill, index) => (
    `\`${index + 1}.\` **${skill.name || "Unknown"}** · ${renderPercentGauge(skill.share)} · crit ${pct(skill.critRate)}`
  ));
  if (!skillLines.length) return null;
  return {
    name: hudFieldName("top skills"),
    value: skillLines.join("\n"),
    inline: false,
  };
}

function buildRaidBreakdownField(character, { lang, isBibleSummary }) {
  const sortedRaids = [...(character.raids || [])]
    .sort((a, b) => Number(b?.encounters || 0) - Number(a?.encounters || 0));
  const raidLines = sliceMapWithOverflow(sortedRaids, 8, (raid) => {
    const raidLabel = getRaidModeLabel(raid.raidKey, raid.modeKey, lang) || `${raid.raidKey} ${raid.modeKey}`;
    if (isBibleSummary) {
      return `**${raidLabel}** · ${raid.boss || "?"} · ${raid.encounters || 0} log · DPS ${shortNumber(raid.medianDps)} · Bible pct ${pct(raid.avgBiblePercentile)} · deathless ${pct(raid.deathlessRate)}`;
    }
    return `**${raidLabel}** · ${raid.boss || "?"} · ${raid.encounters || 0} log · DPS ${shortNumber(raid.medianDps)} · share ${pct(raid.avgDamageShare)} · top ${pct(raid.topRate)}`;
  });
  return {
    name: hudFieldName("raid breakdown"),
    value: raidLines.length ? raidLines.join("\n") : t("raidProfile.noRaidBreakdown", lang),
    inline: false,
  };
}

function buildCharacterExtraFields(character, { lang, isBibleSummary }) {
  const stats = character.stats || {};
  return [
    buildRoleDetectionField(character, stats),
    buildBuffProfileField(character, stats, { isBibleSummary }),
    buildBuildField(character, stats),
    buildTopSkillsField(character),
    buildRaidBreakdownField(character, { lang, isBibleSummary }),
  ].filter(Boolean);
}

module.exports = {
  buildCharacterExtraFields,
  buildRaidBreakdownField,
  buildTopSkillsField,
};
