/**
 * ArtistEmoji.js
 *
 * Map of Artist persona emoji name -> Discord application emoji string.
 *
 * Seeded empty here. The bot's startup bootstrap
 * (`bootstrapArtistEmoji` in `bot/services/discord/emoji-bootstrap.js`) populates
 * entries at runtime by uploading PNGs from `assets/artist-icons/` as
 * application emoji (content-addressed naming: `{name}_{md5short}`)
 * and mutating this map with the resulting `<:name:id>` strings keyed
 * by persona name (the PNG filename without extension).
 *
 * Any persona missing from the map (bootstrap hasn't run yet, or upload
 * failed) renders as empty string - safe no-op fallback so callers can
 * unconditionally do `${getArtistEmoji('shy')} Chào...` without a
 * truthiness check.
 *
 * Persona expressions (current set):
 *   - `shy`: blushing/embarrassed face. Use for warm greetings,
 *     compliments, embarrassed moments.
 *   - `neutral`: default cute face. Use for most neutral statements
 *     where you want a persona presence without specific emotion.
 *   - `note`: chibi reading a book. Use for "Artist is checking" /
 *     "Artist is taking notes" / processing-style messages.
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
 * @param {string} name - Persona name (e.g., "shy", "neutral", "note").
 * @returns {string} Discord custom emoji string `<:name:id>` for the
 *   persona, or empty string when the persona isn't mapped (yet) -
 *   empty string is a safe no-op when prepended to a message template
 *   literal.
 */
function getArtistEmoji(name) {
  return ARTIST_EMOJI_MAP[String(name || '').trim()] || '';
}

module.exports = {
  ARTIST_EMOJI_MAP,
  getArtistEmoji,
};
