/**
 * services/raid/artist-ping/ping-responder.js
 * Turns an @Artist mention into a reply, or into silence.
 *
 * Invariants:
 *  - One reply per user per cooldown window. The second ping inside the window
 *    is answered once with the `spam` bucket and then ignored entirely, so a
 *    user hammering the mention cannot make Artist hammer the channel back.
 *  - Everything time-related is injected, so tests never touch the clock.
 *  - A failure to reply is swallowed: chatter must never break the raid flow.
 */

"use strict";

const { classifyArtistPing } = require("./ping-classify");
const { tPick } = require("../../i18n");

const DEFAULT_COOLDOWN_MS = 60_000;
// Two answers per window: the real one, then one `spam` nudge. Anything beyond
// that is silence, otherwise the nudge itself becomes the spam.
const MAX_REPLIES_PER_WINDOW = 2;

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Current hour (0-23) in Vietnam. Artist's sleep window is expressed in VN
 * time to stay consistent with the bedtime and reset announcements.
 * @param {Date} [now]
 * @returns {number}
 */
function vietnamHourNow(now = new Date()) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: VIETNAM_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return Number(value);
}

/**
 * Build the ping responder.
 *
 * @param {Object} [deps]
 * @param {number} [deps.cooldownMs=60000] - per-user quiet window
 * @param {() => number} [deps.clock] - epoch ms source, injected for tests
 * @param {(now?: Date) => number} [deps.getVietnamHour]
 * @param {(key: string, lang: string, vars: Object) => string} [deps.translate]
 * @returns {{buildPingReply: Function, resetCooldowns: Function}}
 */
function createArtistPingResponder({
  cooldownMs = DEFAULT_COOLDOWN_MS,
  clock = () => Date.now(),
  getVietnamHour = vietnamHourNow,
  translate = tPick,
} = {}) {
  // userId -> { windowStart, replies }
  const recent = new Map();

  function noteReply(userId, now) {
    const entry = recent.get(userId);
    if (!entry || now - entry.windowStart >= cooldownMs) {
      recent.set(userId, { windowStart: now, replies: 1 });
      return { firstInWindow: true, replies: 1 };
    }
    entry.replies += 1;
    return { firstInWindow: false, replies: entry.replies };
  }

  /**
   * @param {Object} input
   * @param {string} input.content - raw message content
   * @param {string} input.userId - author id, used for the mention and cooldown
   * @param {boolean} input.mentionsArtist
   * @param {boolean} [input.fromBot]
   * @param {boolean} [input.parsesAsRaidCommand]
   * @param {string} [input.lang='vi']
   * @returns {string|null} reply text, or null when Artist should stay quiet
   */
  function buildPingReply({
    content,
    userId,
    mentionsArtist,
    fromBot = false,
    parsesAsRaidCommand = false,
    lang = "vi",
  }) {
    if (!mentionsArtist || fromBot || parsesAsRaidCommand || !userId) return null;

    const now = clock();
    const { firstInWindow, replies } = noteReply(userId, now);
    if (replies > MAX_REPLIES_PER_WINDOW) return null;

    const bucket = classifyArtistPing({
      content,
      mentionsArtist,
      fromBot,
      parsesAsRaidCommand,
      recentlyAnswered: !firstInWindow,
      vietnamHour: getVietnamHour(new Date(now)),
    });
    if (!bucket) return null;

    return translate(`artistPing.${bucket}`, lang, { user: `<@${userId}>` });
  }

  function resetCooldowns() {
    recent.clear();
  }

  return { buildPingReply, resetCooldowns };
}

module.exports = {
  createArtistPingResponder,
  MAX_REPLIES_PER_WINDOW,
};
