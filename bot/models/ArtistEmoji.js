/**
 * ArtistEmoji.js
 *
 * Map of bot expression names to Discord application emoji strings.
 *
 * Seeded empty here. The bot's startup bootstrap
 * (`bootstrapArtistEmoji` in `bot/services/discord/emoji-bootstrap.js`) populates
 * entries at runtime by uploading PNGs from `assets/artist-icons/` as
 * application emoji (content-addressed naming: `{name}_{md5short}`)
 * and mutating this map with the resulting `<:name:id>` strings keyed by
 * expression name (the PNG filename without extension).
 *
 * Any expression missing from the map (bootstrap has not run or upload
 * failed) renders as an empty string, so callers can
 * prepend getArtistEmoji(name) without a truthiness check.
 *
 * Expression keys (current set):
 *   - `shy`: blushing face for greetings or positive acknowledgements.
 *   - `neutral`: default face for messages without a specific emotion.
 *   - `note`: reading face for progress or processing messages.
 *
 * Format: `<:emoji_name:emoji_id>` (no spaces, no leading backslash).
 * Bootstrap fills with hash-suffixed names like `<:shy_a3f9b2:123>`.
 */
const ARTIST_EMOJI_MAP = {
  shy: '',
  neutral: '',
  note: '',
};

/**
 * @param {string} name - Expression name (e.g., "shy", "neutral", "note").
 * @returns {string} Discord custom emoji string `<:name:id>` for the
 *   expression, or an empty string when the expression is not mapped.
 */
function getArtistEmoji(name) {
  return ARTIST_EMOJI_MAP[String(name || '').trim()] || '';
}

module.exports = {
  ARTIST_EMOJI_MAP,
  getArtistEmoji,
};
