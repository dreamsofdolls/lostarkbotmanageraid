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

// lostark.bible numeric class IDs seen in LOA Logs `encounter_preview.players`
// payloads. Values point at the canonical bible class ID, which also matches
// `assets/class-icons/<id>.png`.
const CLASS_ID_TO_BIBLE_ID = {
  102: 'berserker',
  103: 'destroyer',
  104: 'warlord',
  105: 'holyknight',
  112: 'berserker_female',
  113: 'holyknight_female',
  202: 'arcana',
  203: 'summoner',
  204: 'bard',
  205: 'elemental_master',
  302: 'battle_master',
  303: 'infighter',
  304: 'soulmaster',
  305: 'lance_master',
  312: 'battle_master_male',
  313: 'infighter_male',
  402: 'blade',
  403: 'demonic',
  404: 'reaper',
  405: 'soul_eater',
  502: 'hawk_eye',
  503: 'devil_hunter',
  504: 'blaster',
  505: 'scouter',
  512: 'devil_hunter_female',
  602: 'yinyangshi',
  603: 'weather_artist',
  604: 'alchemist',
  701: 'dragon_knight',
  702: 'dragon_knight',
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

function getClassInfoByNumericId(classId) {
  const bibleId = CLASS_ID_TO_BIBLE_ID[String(classId)] || '';
  if (!bibleId) return { classId: String(classId || ''), bibleId: '', className: '' };
  return {
    classId: String(classId),
    bibleId,
    className: getClassName(bibleId),
  };
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

/**
 * Map of class display name -> Discord application emoji string.
 *
 * Seeded empty here. The bot's startup bootstrap
 * (`bot/services/class-emoji-bootstrap.js`) populates entries at runtime
 * by uploading PNGs from `assets/class-icons/` as application emoji
 * (content-addressed naming: `{bibleId}_{md5short}`) and mutating this
 * map with the resulting `<:name:id>` strings keyed by display name.
 *
 * Any class missing from the map (bootstrap hasn't run yet, or upload
 * failed) renders without an icon prefix - safe no-op fallback so the
 * bot keeps working with degraded UX rather than crashing.
 *
 * Format: `<:emoji_name:emoji_id>` (no spaces, no leading backslash).
 */
const CLASS_EMOJI_MAP = {
  // Warriors
  Berserker: '',
  Slayer: '',
  Gunlancer: '',
  Paladin: '',
  Valkyrie: '',
  Destroyer: '',
  'Guardian Knight': '',
  // Martial Artists
  Wardancer: '',
  Scrapper: '',
  Soulfist: '',
  Glaivier: '',
  Striker: '',
  Breaker: '',
  // Gunners
  Deadeye: '',
  Gunslinger: '',
  Artillerist: '',
  Sharpshooter: '',
  Machinist: '',
  // Mages
  Bard: '',
  Arcanist: '',
  Summoner: '',
  Sorceress: '',
  // Assassins
  Deathblade: '',
  'Shadow Hunter': '',
  Reaper: '',
  Souleater: '',
  // Specialists
  Artist: '',
  Aeromancer: '',
  Wildsoul: '',
};

/**
 * @param {string} className - Display name (e.g., "Bard", "Berserker").
 * @returns {string} Discord custom emoji string `<:name:id>` for the class,
 *   or empty string when the class isn't mapped (yet) - empty string is a
 *   safe no-op when prepended to a char name template literal.
 */
function getClassEmoji(className) {
  return CLASS_EMOJI_MAP[String(className || '').trim()] || '';
}

module.exports = {
  CLASS_NAMES,
  CLASS_ID_TO_BIBLE_ID,
  getClassName,
  getClassInfoByNumericId,
  SUPPORT_CLASS_NAMES,
  isSupportClass,
  CLASS_EMOJI_MAP,
  getClassEmoji,
};
