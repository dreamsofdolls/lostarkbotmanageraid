"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PING_BUCKETS,
  classifyArtistPing,
} = require("../bot/services/raid/artist-ping/ping-classify");

const ping = (content, extra = {}) =>
  classifyArtistPing({ content, mentionsArtist: true, ...extra });

test("a message that does not mention Artist is not answered", () => {
  assert.equal(classifyArtistPing({ content: "chào cả nhà", mentionsArtist: false }), null);
});

test("bots never get a reply", () => {
  assert.equal(ping("<@1> hi", { fromBot: true }), null);
});

test("a raid clear that happens to tag Artist belongs to the parser", () => {
  // The load-bearing guard: chatter must never steal a progress update.
  assert.equal(ping("<@1> Act4 Hard Soulrano", { parsesAsRaidCommand: true }), null);
});

test("a bare mention is its own bucket", () => {
  assert.equal(ping("<@1>"), "bare");
  assert.equal(ping("  <@!1>   "), "bare");
});

test("content buckets are recognised in Vietnamese, English and Japanese", () => {
  assert.equal(ping("<@1> chào cậu"), "greeting");
  assert.equal(ping("<@1> hello"), "greeting");
  assert.equal(ping("<@1> こんにちは"), "greeting");

  assert.equal(ping("<@1> cảm ơn nhé"), "thanks");
  assert.equal(ping("<@1> thanks!"), "thanks");

  assert.equal(ping("<@1> giỏi lắm"), "praise");
  assert.equal(ping("<@1> good bot"), "praise");

  assert.equal(ping("<@1> help"), "help");
  assert.equal(ping("<@1> làm sao để add roster"), "help");

  assert.equal(ping("<@1> status"), "status");
  assert.equal(ping("<@1> tiến độ sao rồi"), "status");
});

test("Vietnamese words ending in an accented vowel still match", () => {
  // Regression guard: an ASCII \b finds no boundary after "độ" (U+1ED9 is not
  // a \w char), so the whole status pattern used to fall through to fallback.
  assert.equal(ping("<@1> tiến độ"), "status");
  assert.equal(ping("<@1> cho xem tiến độ với"), "status");
  // ...while still refusing a word that merely contains the term.
  assert.equal(ping("<@1> statusbar"), "fallback");
});

test("calling Artist a cat is its own bucket, diacritics or not", () => {
  assert.equal(ping("<@1> mèo"), "tease");
  assert.equal(ping("<@1> con meo cam"), "tease");
  assert.equal(ping("<@1> bad bot"), "tease");
});

test("a question mark falls through to the question bucket", () => {
  assert.equal(ping("<@1> hôm nay reset chưa?"), "question");
});

test("anything else lands in fallback", () => {
  assert.equal(ping("<@1> ừ thì đấy"), "fallback");
});

test("context outranks content", () => {
  // Pinged again inside the cooldown - what was said stops mattering.
  assert.equal(ping("<@1> chào", { recentlyAnswered: true }), "spam");
  // Artist sleeps 03:00-07:59 VN, matching the bedtime announcement lore.
  assert.equal(ping("<@1> chào", { vietnamHour: 4 }), "sleeping");
  assert.equal(ping("<@1> chào", { vietnamHour: 8 }), "greeting");
  assert.equal(ping("<@1> chào", { vietnamHour: 2 }), "greeting");
  // Spam beats sleeping: the newer signal about how they pinged wins.
  assert.equal(ping("<@1> chào", { vietnamHour: 4, recentlyAnswered: true }), "spam");
});

test("every returned bucket is declared in PING_BUCKETS", () => {
  const samples = [
    ping("<@1>"),
    ping("<@1> hi"),
    ping("<@1> cảm ơn"),
    ping("<@1> giỏi lắm"),
    ping("<@1> mèo"),
    ping("<@1> help"),
    ping("<@1> status"),
    ping("<@1> sao thế?"),
    ping("<@1> gì đó"),
    ping("<@1> hi", { recentlyAnswered: true }),
    ping("<@1> hi", { vietnamHour: 5 }),
  ];
  for (const bucket of samples) assert.ok(PING_BUCKETS.includes(bucket), `stray bucket: ${bucket}`);
  assert.equal(new Set(samples).size, PING_BUCKETS.length, "every bucket should be reachable");
});
