const test = require("node:test");
const assert = require("node:assert/strict");

const { parseStartTime } = require("../bot/services/raid/schedule/time-parse");

// Fixed anchor: 2026-05-29 05:00:00 UTC (= 12:00 VN, 14:00 JST, 05:00 UTC/en).
const NOW = new Date(Date.UTC(2026, 4, 29, 5, 0, 0));

test("relative +Nh / +Nm is timezone-independent", () => {
  assert.equal(parseStartTime("+2h", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 7, 0));
  assert.equal(parseStartTime("+90m", "jp", NOW).getTime(), Date.UTC(2026, 4, 29, 6, 30));
});

test("HH:MM resolves in the lead's language timezone", () => {
  // 20:00 VN = 13:00 UTC; 20:00 JST = 11:00 UTC; 20:00 en(UTC) = 20:00 UTC.
  assert.equal(parseStartTime("20:00", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));
  assert.equal(parseStartTime("20:00", "jp", NOW).getTime(), Date.UTC(2026, 4, 29, 11, 0));
  assert.equal(parseStartTime("20:00", "en", NOW).getTime(), Date.UTC(2026, 4, 29, 20, 0));
});

test("HH:MM already past today rolls to the next day", () => {
  const late = new Date(Date.UTC(2026, 4, 29, 13, 30)); // 20:30 VN
  assert.equal(parseStartTime("20:00", "vi", late).getTime(), Date.UTC(2026, 4, 30, 13, 0));
});

test("invalid input returns null", () => {
  assert.equal(parseStartTime("25:00", "vi", NOW), null);
  assert.equal(parseStartTime("20:99", "vi", NOW), null);
  assert.equal(parseStartTime("+0h", "vi", NOW), null);
  assert.equal(parseStartTime("tonight", "vi", NOW), null);
  assert.equal(parseStartTime("", "vi", NOW), null);
});
