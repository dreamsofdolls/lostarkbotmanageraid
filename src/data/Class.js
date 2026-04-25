/**
 * Mapping of lostark.bible internal class IDs to display names.
 * Update this file when new classes are added to the game.
 */
const CLASS_NAMES = {
  // Warriors
  berserker:          'Berserker',
  berserker_female:   'Slayer',
  dragon_knight:      'Guardian Knight',
  warlord:            'Gunlancer',
  holyknight:         'Paladin',
  holyknight_female:  'Valkyrie',
  destroyer:          'Destroyer',

  // Martial Artists
  battle_master:      'Wardancer',
  infighter:          'Scrapper',
  soulmaster:         'Soulfist',
  force_master:       'Soulfist',
  lance_master:       'Glaivier',
  infighter_male:     'Breaker',
  battle_master_male:  'Striker',

  // Gunners
  devil_hunter:       'Deadeye',
  devil_hunter_female:'Gunslinger',
  blaster:            'Artillerist',
  hawkeye:            'Sharpshooter',
  hawk_eye:           'Sharpshooter',
  scouter:            'Machinist',

  // Mages
  bard:               'Bard',
  arcana:             'Arcanist',
  summoner:           'Summoner',
  elemental_master:   'Sorceress',

  // Assassins
  blade:              'Deathblade',
  demonic:            'Shadow Hunter',
  reaper:             'Reaper',
  soul_eater:         'Souleater',

  // Specialists
  yinyangshi:         'Artist',
  weather_artist:     'Aeromancer',
  alchemist:          'Wildsoul',
};

/**
 * Resolve a lostark.bible class ID to a human-readable display name.
 * Falls back to a title-cased version of the ID if not found.
 * @param {string} clsId
 * @returns {string}
 */
function getClassName(clsId) {
  if (!clsId) return '';
  return CLASS_NAMES[clsId] ?? clsId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Hard-support classes in current Lost Ark meta. Everyone else is DPS.
 * Used by /raid-check dropdowns to show per-user role breakdown so a
 * leader can see at a glance whether a pending backlog is mostly
 * supports (group-blocking for raid composition) or mostly DPS.
 *
 * Stored as display names (not bible class IDs) because the consuming
 * code reads `character.class` which is already the resolved display
 * name. Update this set when Smilegate releases a new support class.
 */
const SUPPORT_CLASS_NAMES = new Set([
  'Bard',
  'Paladin',
  'Artist',
  'Valkyrie',
]);

/**
 * @param {string} className - Display name (e.g., "Bard", "Berserker").
 * @returns {boolean} True if the class is a hard-support.
 */
function isSupportClass(className) {
  return SUPPORT_CLASS_NAMES.has(String(className || '').trim());
}

module.exports = {
  CLASS_NAMES,
  getClassName,
  SUPPORT_CLASS_NAMES,
  isSupportClass,
};
