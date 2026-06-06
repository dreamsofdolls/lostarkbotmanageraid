"use strict";

const {
  CHARACTER_PROFILE_STATS_KEYS,
  CHARACTER_PROFILE_STATS_CLAMP_RULES,
  CHARACTER_PROFILE_SCORE_KEYS,
} = require("../sanitize-rules");
const {
  MAX_BUILD_VARIANTS_PER_CHAR,
  MAX_RAID_BREAKDOWNS_PER_CHAR,
  MAX_TOP_SKILLS_PER_CHAR,
  MAX_TOP_SOURCES_PER_CHAR,
} = require("./constants");
const {
  applyClampRules,
  clampNumber,
  cleanAttackStyle,
  cleanLimitedList,
  cleanNumberObject,
  cleanRole,
  cleanShortString,
  roleForClass,
} = require("./common");
const {
  cleanBuild,
} = require("./build");
const {
  cleanBuildVariant,
  cleanRaidBreakdown,
  cleanTopSkill,
  cleanTopSource,
} = require("./items");

// Flex characters carry a second build's full profile (e.g. a support class
// that also ran a DPS build). Keep role + log count + the same stats/score
// whitelist as the primary so the alt build can render its own metric table;
// null when absent or malformed.
function cleanAltBuild(rawAlt) {
  if (!rawAlt || typeof rawAlt !== "object") return null;
  const role = rawAlt.role === "support" ? "support" : rawAlt.role === "dps" ? "dps" : null;
  if (!role) return null;
  const stats = cleanNumberObject(rawAlt.stats, CHARACTER_PROFILE_STATS_KEYS, { max: 9999999999999 });
  applyClampRules(stats, CHARACTER_PROFILE_STATS_CLAMP_RULES);
  stats.attackStyle = cleanAttackStyle(rawAlt.stats?.attackStyle);
  return {
    role,
    encounters: clampNumber(rawAlt.encounters, { max: 100000 }),
    stats,
    scores: cleanNumberObject(rawAlt.scores, CHARACTER_PROFILE_SCORE_KEYS, { max: 100 }),
  };
}

function cleanCharacterProfile(rawChar, rosterEntry) {
  if (!rawChar || typeof rawChar !== "object" || !rosterEntry) return null;

  const stats = cleanNumberObject(rawChar.stats, CHARACTER_PROFILE_STATS_KEYS, { max: 9999999999999 });
  applyClampRules(stats, CHARACTER_PROFILE_STATS_CLAMP_RULES);
  stats.attackStyle = cleanAttackStyle(rawChar.stats?.attackStyle);

  const scores = cleanNumberObject(rawChar.scores, CHARACTER_PROFILE_SCORE_KEYS, { max: 100 });

  const raids = cleanLimitedList(rawChar.raids, MAX_RAID_BREAKDOWNS_PER_CHAR, cleanRaidBreakdown);
  const topSkills = cleanLimitedList(rawChar.topSkills, MAX_TOP_SKILLS_PER_CHAR, cleanTopSkill);
  const topBuffSources = cleanLimitedList(rawChar.topBuffSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topDebuffSources = cleanLimitedList(rawChar.topDebuffSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topShieldGivenSources = cleanLimitedList(rawChar.topShieldGivenSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const topShieldReceivedSources = cleanLimitedList(rawChar.topShieldReceivedSources, MAX_TOP_SOURCES_PER_CHAR, cleanTopSource);
  const buildVariants = cleanLimitedList(rawChar.buildVariants, MAX_BUILD_VARIANTS_PER_CHAR, cleanBuildVariant);

  const className = rosterEntry.character?.class || cleanShortString(rawChar.class, 80);
  const classRole = roleForClass(className, rawChar.classRole);
  return {
    name: rosterEntry.charName,
    class: className,
    itemLevel: clampNumber(rosterEntry.character?.itemLevel, { max: 9999 }),
    classRole,
    role: cleanRole(rawChar.role, classRole),
    stats,
    scores,
    altBuild: cleanAltBuild(rawChar.altBuild),
    build: cleanBuild(rawChar.build),
    topSkills,
    topBuffSources,
    topDebuffSources,
    topShieldGivenSources,
    topShieldReceivedSources,
    buildVariants,
    raids,
  };
}

module.exports = {
  cleanCharacterProfile,
};
