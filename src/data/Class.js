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

/**
 * Map of class display name -> Discord guild custom emoji string. Discord
 * cannot render local PNG files inline, so each class icon must first be
 * uploaded to the Thaemine server's emoji slots, then the resulting
 * `<:name:id>` form pasted into this map.
 *
 * The bot reads `character.class` (the resolved display name) and looks up
 * the emoji here. Any class missing from the map renders without an icon
 * prefix - safe no-op fallback so the bot keeps working while emoji are
 * being uploaded one at a time.
 *
 * Source PNG files (named by bible class ID, not display name) live under
 * `assets/class-icons/` with a README documenting the upload workflow.
 *
 * Format: `<:emoji_name:emoji_id>` (no spaces, no leading backslash). To
 * extract the ID from a freshly-uploaded emoji, type `\:bard:` in any
 * channel - Discord will print the raw form so you can copy it.
 *
 * Recommended workflow: run `node scripts/upload-class-emoji.js` once to
 * bulk-upload every PNG in `assets/class-icons/` to the Thaemine guild
 * via the Discord REST API. The script writes the resulting
 * `assets/class-icons/emoji-map.json` which is auto-merged into this
 * map at module load (see the merge block below). Manual paste is only
 * needed if a class is missing from the script's output (e.g., 5 newer
 * classes the source folder doesn't have art for yet).
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

// Auto-merge `assets/class-icons/emoji-map.json` over the empty seeds above
// when the file exists. The upload script writes that file after pushing
// emoji to the Thaemine guild, so the only manual step is committing the
// JSON. Wrapped in try/catch so a missing/malformed file falls back
// silently to the empty defaults (bot keeps rendering without icons).
try {
  const path = require('path');
  const emojiMapPath = path.resolve(__dirname, '..', '..', 'assets', 'class-icons', 'emoji-map.json');
  const overrides = require(emojiMapPath);
  if (overrides && typeof overrides === 'object') {
    for (const [displayName, emojiString] of Object.entries(overrides)) {
      if (typeof emojiString === 'string' && emojiString.length > 0) {
        CLASS_EMOJI_MAP[displayName] = emojiString;
      }
    }
  }
} catch (err) {
  // ENOENT (file not yet generated) is the normal pre-upload state.
  // Anything else (parse error, etc.) we silently ignore so a bad file
  // can't take down the bot - the empty-map no-op fallback is correct
  // default behavior either way.
  if (err && err.code !== 'MODULE_NOT_FOUND') {
    console.warn('[Class.js] failed to load emoji-map.json:', err?.message || err);
  }
}

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
  getClassName,
  SUPPORT_CLASS_NAMES,
  isSupportClass,
  CLASS_EMOJI_MAP,
  getClassEmoji,
};
