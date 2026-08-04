"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
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

test("cooldowns are tracked per user, not globally", () => {
  const r = harness();
  ping(r, { userId: "u1" });
  ping(r, { userId: "u1" });
  assert.equal(ping(r, { userId: "u1" }), null);
  assert.match(ping(r, { userId: "u2" }), /artistPing\.greeting/);
});

test("pinging inside the sleep window wakes a drowsy Artist", () => {
  const r = harness({ hour: 4 });
  assert.match(ping(r), /artistPing\.sleeping/);
});

test("resetCooldowns clears the window state", () => {
  const r = harness();
  ping(r);
  ping(r);
  assert.equal(ping(r), null);
  r.resetCooldowns();
  assert.match(ping(r), /artistPing\.greeting/);
});
