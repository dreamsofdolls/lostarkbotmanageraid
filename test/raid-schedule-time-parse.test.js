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

// --- forgiving formats (Traine: "user nhập không bị cấn tay") ---
// All resolved in vi tz at NOW (12:00 VN). 20:00 VN = 13:00 UTC.
test("VN hour forms: 20h / 21h30 / 21g / 21g30 parse like the clock", () => {
  assert.equal(parseStartTime("20h", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));
  assert.equal(parseStartTime("21h30", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 14, 30));
  assert.equal(parseStartTime("21g", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 14, 0));
  assert.equal(parseStartTime("21g30", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 14, 30));
});

test("dot separator + bare hour + HHMM digits", () => {
  assert.equal(parseStartTime("20.30", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 30));
  assert.equal(parseStartTime("20", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));   // bare hour
  assert.equal(parseStartTime("2000", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));  // HHMM
  assert.equal(parseStartTime("2030", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 30));
});

test("12-hour am/pm (only when explicit)", () => {
  assert.equal(parseStartTime("8pm", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));   // 20:00 VN
  assert.equal(parseStartTime("1pm", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 6, 0));    // 13:00 VN
  assert.equal(parseStartTime("8:30 pm", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 30));
  assert.equal(parseStartTime("12am", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 17, 0));  // 00:00 VN next day
  assert.equal(parseStartTime("20pm", "vi", NOW), null);  // hour > 12 with am/pm is invalid
});

test("a bare hour earlier than now rolls to the next day", () => {
  // 8h VN < 12h now -> tomorrow 08:00 VN = 2026-05-30 01:00 UTC.
  assert.equal(parseStartTime("8h", "vi", NOW).getTime(), Date.UTC(2026, 4, 30, 1, 0));
  assert.equal(parseStartTime("830", "vi", NOW).getTime(), Date.UTC(2026, 4, 30, 1, 30));
});

test("relative tolerates surrounding spaces", () => {
  assert.equal(parseStartTime(" + 2h ", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 7, 0));
});
