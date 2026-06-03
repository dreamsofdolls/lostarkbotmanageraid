const test = require("node:test");
const assert = require("node:assert/strict");

const { formatStartShortForLang } = require("../bot/utils/raid/schedule/artist-clock");

test("formatStartShortForLang renders DD/MM HH:mm in the viewer's language tz", () => {
  // 2026-06-03 14:00 UTC.
  const utc = new Date(Date.UTC(2026, 5, 3, 14, 0));
  assert.equal(formatStartShortForLang(utc, "vi"), "03/06 21:00"); // +7
  assert.equal(formatStartShortForLang(utc, "jp"), "03/06 23:00"); // +9
  assert.equal(formatStartShortForLang(utc, "en"), "03/06 14:00"); // +0
});

test("formatStartShortForLang rolls the date across the local midnight boundary", () => {
  // 2026-06-03 20:00 UTC -> JP (+9) = 2026-06-04 05:00 local.
  const utc = new Date(Date.UTC(2026, 5, 3, 20, 0));
  assert.equal(formatStartShortForLang(utc, "jp"), "04/06 05:00");
});

test("formatStartShortForLang defaults unknown languages to the VN tz", () => {
  const utc = new Date(Date.UTC(2026, 5, 3, 14, 0));
  assert.equal(formatStartShortForLang(utc, "zz"), "03/06 21:00"); // falls back to +7
});
