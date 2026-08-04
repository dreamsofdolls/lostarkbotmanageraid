/**
 * services/raid/artist-ping/ping-classify.js
 * Pure classifier turning an @Artist mention into a response bucket.
 *
 * Invariants:
 *  - No Discord objects and no clock reads here; everything arrives as
 *    arguments so the whole thing is deterministic under test.
 *  - Context buckets (spam, sleeping) outrank content buckets: how the ping
 *    arrived matters more than what it said.
 *  - `null` means "not a ping for Artist to answer" and the caller stays quiet.
 *    Silence is the correct answer far more often than a reply.
 */

"use strict";

/** Every bucket the responder can render, in match order. */
const PING_BUCKETS = Object.freeze([
  "spam",
  "sleeping",
  "tease",
  "thanks",
  "praise",
  "greeting",
  "help",
  "status",
  "question",
  "bare",
  "fallback",
]);

// Two maps on purpose. \b is an ASCII word boundary, so it is wrong twice over
// here: it can never match a run of kana or kanji, and it silently fails on
// Vietnamese words that end in an accented vowel - "độ" ends in U+1ED9, which
// is not a \w character, so \b finds no transition before the following space.
// W() builds a Unicode-aware boundary instead. Vietnamese terms also accept the
// plain-ASCII spelling since people type both ways, and every `d` that could be
// `đ` is written [dđ] (độ, dễ, dại, dụng).
const W = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "u");

const WORD_PATTERNS = Object.freeze({
  tease: W("m[eè]o|meo|neko|cat|ngu|[dđ][uạ]i|dumb|stupid|bad bot|useless|v[oô] [dđ][uụ]ng"),
  thanks: W("c[aả]m [oơ]n|cam on|thanks|thank you|thx|arigatou"),
  praise: W("gi[oỏ]i|ngoan|cute|[dđ][eễ] th[uư][oơ]ng|good bot|good girl|best bot|t[oố]t l[aắ]m|xu[aấ]t s[aắ]c"),
  greeting: W("ch[aà]o|hi|hii+|hello|hey|yo|alo|halo|konnichiwa|ohayou|good morning"),
  help: W("help|gi[uú]p|h[uư][oớ]ng d[aẫ]n|huong dan|how do i|l[aà]m sao|c[aá]ch d[uù]ng"),
  status: W("status|ti[eế]n [dđ][oộ]|tien do|progress|raid n[aà]o|c[oò]n g[iì]"),
});

const CJK_PATTERNS = Object.freeze({
  tease: /(ばか|馬鹿|役立たず)/u,
  thanks: /(ありがとう|感謝)/u,
  praise: /(えらい|かわいい|優秀)/u,
  greeting: /(こんにちは|おはよ|やあ|こんばんは)/u,
  help: /(使い方|ヘルプ|助けて)/u,
  status: /(進捗|状況)/u,
});

const CONTENT_BUCKET_ORDER = Object.freeze([
  "tease",
  "thanks",
  "praise",
  "greeting",
  "help",
  "status",
]);

/**
 * Decide which response bucket an @Artist mention falls into.
 *
 * @param {Object} input
 * @param {string} input.content - raw message content, mention markup included
 * @param {boolean} input.mentionsArtist - true when the bot user was mentioned
 *   directly (an @everyone/@here sweep must NOT set this)
 * @param {boolean} [input.fromBot=false] - author is a bot or webhook
 * @param {boolean} [input.parsesAsRaidCommand=false] - the raid text parser
 *   already claimed this message; chatter must not steal it
 * @param {boolean} [input.recentlyAnswered=false] - this user was answered
 *   inside the cooldown window
 * @param {number} [input.vietnamHour] - 0-23 local Vietnam hour; Artist sleeps
 *   03:00-07:59 to stay consistent with the bedtime announcement lore
 * @returns {string|null} a bucket from PING_BUCKETS, or null to stay silent
 */
function classifyArtistPing({
  content,
  mentionsArtist,
  fromBot = false,
  parsesAsRaidCommand = false,
  recentlyAnswered = false,
  vietnamHour,
} = {}) {
  if (!mentionsArtist || fromBot) return null;
  // The parser owns raid updates. `@Artist Act4 HM Soulrano` is a clear post
  // that happens to tag her, not a conversation opener.
  if (parsesAsRaidCommand) return null;

  if (recentlyAnswered) return "spam";
  if (Number.isInteger(vietnamHour) && vietnamHour >= 3 && vietnamHour < 8) return "sleeping";

  // Strip the mention markup, then any leftover punctuation-only noise.
  const stripped = String(content || "")
    .replace(/<@!?\d+>/g, " ")
    .trim();
  if (stripped.length === 0) return "bare";

  const folded = stripped.toLowerCase();
  for (const bucket of CONTENT_BUCKET_ORDER) {
    if (WORD_PATTERNS[bucket].test(folded) || CJK_PATTERNS[bucket].test(stripped)) return bucket;
  }
  if (/[?？]/.test(stripped)) return "question";
  return "fallback";
}

module.exports = {
  PING_BUCKETS,
  classifyArtistPing,
};
