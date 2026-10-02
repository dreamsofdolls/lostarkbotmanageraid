"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARTIST_PING_COOLDOWN_MAX_ENTRIES,
  createArtistPingResponder,
  MAX_REPLIES_PER_WINDOW,
} = require("../bot/services/raid/artist-ping/ping-responder");

/** A responder with a frozen clock and a translate that echoes its inputs. */
function harness({ hour = 12, cooldownMs = 60_000 } = {}) {
  let now = 1_000_000;
  const responder = createArtistPingResponder({
    cooldownMs,
    clock: () => now,
    getVietnamHour: () => hour,
    translate: (key, lang, vars) => `${key}|${lang}|${vars.user}`,
  });
  return {
    ...responder,
    advance: (ms) => {
      now += ms;
    },
  };
}

const ping = (r, extra = {}) =>
  r.buildPingReply({
    content: "<@1> chào",
    userId: "u1",
    mentionsArtist: true,
    ...extra,
  });

test("a plain mention gets a reply carrying the pinger's mention", () => {
  const r = harness();
  assert.equal(ping(r), "artistPing.greeting|vi|<@u1>");
});

test("the viewer's language is passed through", () => {
  const r = harness();
  assert.match(ping(r, { lang: "jp" }), /\|jp\|/);
});

test("a raid clear that tags Artist gets no chatter", () => {
  const r = harness();
  assert.equal(ping(r, { parsesAsRaidCommand: true }), null);
});

test("bots and mention-less messages get nothing", () => {
  const r = harness();
  assert.equal(ping(r, { fromBot: true }), null);
  assert.equal(ping(r, { mentionsArtist: false }), null);
});

test("the second ping in a window is nudged, the rest are silence", () => {
  const r = harness();
  assert.match(ping(r), /artistPing\.greeting/);
  assert.match(ping(r), /artistPing\.spam/, "second ping should be the spam bucket");
  for (let i = 0; i < 5; i++) {
    assert.equal(ping(r), null, "Artist must not answer past the window cap");
  }
  assert.equal(MAX_REPLIES_PER_WINDOW, 2);
});

test("the window reopens once the cooldown elapses", () => {
  const r = harness({ cooldownMs: 60_000 });
  ping(r);
  ping(r);
  assert.equal(ping(r), null);
  r.advance(60_000);
  assert.match(ping(r), /artistPing\.greeting/, "a fresh window starts clean");
});

test("spam does not extend the original cooldown window", () => {
  const r = harness({ cooldownMs: 60_000 });
  ping(r);
  r.advance(30_000);
  ping(r);
  r.advance(30_000);

  assert.match(ping(r), /artistPing\.greeting/);
});

test("cooldowns are tracked per user, not globally", () => {
  const r = harness();
  ping(r, { userId: "u1" });
  ping(r, { userId: "u1" });
  assert.equal(ping(r, { userId: "u1" }), null);
  assert.match(ping(r, { userId: "u2" }), /artistPing\.greeting/);
});

test("cooldown state evicts the oldest user above its fixed cap", () => {
  const r = harness();
  ping(r, { userId: "oldest" });
  for (let index = 0; index < ARTIST_PING_COOLDOWN_MAX_ENTRIES; index += 1) {
    ping(r, { userId: `user-${index}` });
  }

  assert.match(ping(r, { userId: "oldest" }), /artistPing\.greeting/);
});

test("pinging inside the sleep window wakes a drowsy Artist", () => {
  const r = harness({ hour: 4 });
  assert.match(ping(r), /artistPing\.sleeping/);
});

test("the sleep window follows the guild's clock, not Vietnam's", () => {
  const replyAt = (utcMs, guildLang) =>
    createArtistPingResponder({
      clock: () => utcMs,
      translate: (key) => key,
    }).buildPingReply({
      content: "<@1> chào",
      userId: "u1",
      mentionsArtist: true,
      guildLang,
    });

  // 18:30 UTC: 01:30 in Vietnam, 03:30 in Japan, the hour after jp bedtime.
  const jpBedtime = Date.UTC(2026, 3, 23, 18, 30);
  assert.equal(replyAt(jpBedtime, "jp"), "artistPing.sleeping");
  assert.equal(replyAt(jpBedtime, "vi"), "artistPing.greeting");
  // 23:30 UTC: 06:30 in Vietnam, 08:30 in Japan, after jp wake-up.
  const jpMorning = Date.UTC(2026, 3, 23, 23, 30);
  assert.equal(replyAt(jpMorning, "jp"), "artistPing.greeting");
  assert.equal(replyAt(jpMorning, "vi"), "artistPing.sleeping");
  assert.equal(replyAt(jpMorning, "en"), "artistPing.greeting");
  // 04:30 UTC: 11:30 in Vietnam, inside the en (UTC) window.
  assert.equal(replyAt(Date.UTC(2026, 3, 24, 4, 30), "en"), "artistPing.sleeping");
  // No guild language reads as a Vietnamese guild, as before.
  assert.equal(replyAt(jpMorning, undefined), "artistPing.sleeping");
});

test("resetCooldowns clears the window state", () => {
  const r = harness();
  ping(r);
  ping(r);
  assert.equal(ping(r), null);
  r.resetCooldowns();
  assert.match(ping(r), /artistPing\.greeting/);
});
