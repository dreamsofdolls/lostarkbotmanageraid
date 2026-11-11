"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isDuringArtistSleep,
  isInArtistQuietHoursForLang,
} = require("../bot/utils/raid/schedule/artist-clock");

// Vietnam is UTC+7 and Japan UTC+9; English guilds read UTC.
const vnAt = (hour, minute = 0) => new Date(Date.UTC(2026, 10, 12, hour - 7, minute));
const jstAt = (hour, minute = 0) => new Date(Date.UTC(2026, 10, 12, hour - 9, minute));
const utcAt = (hour, minute = 0) => new Date(Date.UTC(2026, 10, 12, hour, minute));

test("Artist sleeps strictly between 02:00 and 09:00 on a Vietnamese guild's clock", () => {
  assert.equal(isDuringArtistSleep(vnAt(2, 0), "vi"), false);
  assert.equal(isDuringArtistSleep(vnAt(2, 1), "vi"), true);
  assert.equal(isDuringArtistSleep(vnAt(8, 59), "vi"), true);
  assert.equal(isDuringArtistSleep(vnAt(9, 0), "vi"), false);
});

test("English and Japanese guilds keep Artist's sleep on their own clock", () => {
  assert.equal(isDuringArtistSleep(utcAt(4, 0), "en"), true);
  assert.equal(isDuringArtistSleep(utcAt(4, 0), "vi"), false); // 11:00 VN
  assert.equal(isDuringArtistSleep(utcAt(9, 0), "en"), false);
  assert.equal(isDuringArtistSleep(jstAt(2, 30), "jp"), true);
});

test("a millisecond instant reads the same as a Date", () => {
  assert.equal(isDuringArtistSleep(vnAt(4, 0).getTime(), "vi"), true);
});

test("cleanup quiet hours run from 02:00 to 08:59", () => {
  assert.equal(isInArtistQuietHoursForLang(vnAt(1, 59), "vi"), false);
  assert.equal(isInArtistQuietHoursForLang(vnAt(2, 0), "vi"), true);
  assert.equal(isInArtistQuietHoursForLang(vnAt(8, 59), "vi"), true);
  assert.equal(isInArtistQuietHoursForLang(vnAt(9, 0), "vi"), false);
});
