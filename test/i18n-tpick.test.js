/**
 * test/i18n-tpick.test.js
 * Contract tests for the variant picker. The load-bearing one is
 * "bare arrays are not pools": arrays already mean multi-line block in these
 * locales, and mistaking one for a pool would render a single random line out
 * of a paragraph with nothing failing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { t, tPick, DEFAULT_LANGUAGE } = require("../bot/services/i18n");
const { TRANSLATIONS } = require("../bot/locales");

test("plain string keys pass straight through to t()", () => {
  // A key that really exists and is NOT a pool - otherwise both sides would
  // just return the raw key and the assertion would prove nothing.
  const key = "raid-status.sync.cooldownTitle";
  assert.equal(typeof t(key, "vi"), "string");
  assert.notEqual(t(key, "vi"), key);
  assert.equal(tPick(key, "vi"), t(key, "vi"));
});

test("bare arrays are multi-line blocks, never variant pools", () => {
  // welcome.description is a paragraph block consumed via joinIfArray.
  const viaT = t("welcome.description", "vi");
  const viaPick = tPick("welcome.description", "vi");
  assert.ok(Array.isArray(viaT), "fixture should be a bare array");
  assert.deepEqual(viaPick, viaT, "tPick must not collapse a block to one line");
});

test("a {variants} pool yields one member, selectable by index", () => {
  const pool = TRANSLATIONS[DEFAULT_LANGUAGE].announcements["artist-bedtime"].variants;
  assert.ok(pool.length > 1, "fixture should have several variants");

  for (let i = 0; i < pool.length; i++) {
    assert.equal(tPick("announcements.artist-bedtime", "vi", null, { index: i }), pool[i]);
  }
});

test("index wraps so a caller cannot select out of range", () => {
  const pool = TRANSLATIONS[DEFAULT_LANGUAGE].announcements["artist-bedtime"].variants;
  assert.equal(
    tPick("announcements.artist-bedtime", "vi", null, { index: pool.length }),
    pool[0],
  );
  assert.equal(
    tPick("announcements.artist-bedtime", "vi", null, { index: -1 }),
    pool[pool.length - 1],
  );
});

test("an injected RNG makes selection deterministic", () => {
  const pool = TRANSLATIONS[DEFAULT_LANGUAGE].announcements["artist-bedtime"].variants;
  assert.equal(
    tPick("announcements.artist-bedtime", "vi", null, { random: () => 0 }),
    pool[0],
  );
  assert.equal(
    tPick("announcements.artist-bedtime", "vi", null, { random: () => 0.999 }),
    pool[pool.length - 1],
  );
});

test("random selection stays inside the pool", () => {
  const pool = TRANSLATIONS[DEFAULT_LANGUAGE].announcements["artist-bedtime"].variants;
  for (let i = 0; i < 50; i++) {
    assert.ok(pool.includes(tPick("announcements.artist-bedtime", "vi")));
  }
});

test("a missing key still degrades to the raw key string", () => {
  assert.equal(tPick("nope.not.a.key", "vi"), "nope.not.a.key");
});
