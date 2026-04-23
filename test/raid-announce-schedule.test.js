const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/raid-command");

test("nextIntervalTickMs follows scheduler boot phase instead of wall-clock boundaries", () => {
  const startedAt = Date.UTC(2026, 3, 23, 12, 17, 0, 0);
  const now = new Date(Date.UTC(2026, 3, 23, 12, 18, 0, 0));
  const next = __test.nextIntervalTickMs(startedAt, 30 * 60 * 1000, now);
  assert.equal(next, Date.UTC(2026, 3, 23, 12, 47, 0, 0));
});

test("nextIntervalTickMs advances to the following tick when now lands exactly on a tick", () => {
  const startedAt = Date.UTC(2026, 3, 23, 12, 17, 0, 0);
  const now = new Date(Date.UTC(2026, 3, 23, 12, 47, 0, 0));
  const next = __test.nextIntervalTickMs(startedAt, 30 * 60 * 1000, now);
  assert.equal(next, Date.UTC(2026, 3, 23, 13, 17, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs keeps weekly reset on the next Wed 10:00 UTC boundary", () => {
  const now = new Date(Date.UTC(2026, 3, 23, 12, 30, 0, 0)); // Thu Apr 23 2026 19:30 VN
  const next = __test.nextAnnouncementEligibleBoundaryMs("weekly-reset", now);
  assert.equal(next, Date.UTC(2026, 3, 29, 10, 0, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs advances hourly cleanup from an exact hour", () => {
  const now = new Date(Date.UTC(2026, 3, 24, 12, 0, 0, 0));
  const next = __test.nextAnnouncementEligibleBoundaryMs("hourly-cleanup", now);
  assert.equal(next, Date.UTC(2026, 3, 24, 13, 0, 0, 0));
});

test("buildAnnouncementWhenItFiresText shows disabled cleanup when the hourly schedule is off", () => {
  const text = __test.buildAnnouncementWhenItFiresText(
    "hourly-cleanup",
    {
      trigger: "Every VN hour boundary after cleanup.",
      dedup: "1 post/hour",
      messageTtl: "5 phút",
      channelOverridable: false,
    },
    { enabled: true, channelId: null },
    { raidChannelId: "123", autoCleanupEnabled: false },
    new Date(Date.UTC(2026, 3, 24, 12, 10, 0, 0)),
    {}
  );
  assert.match(text, /Disabled until `\/raid-channel config action:schedule-on` is enabled/);
});

test("buildAnnouncementWhenItFiresText shows both boundary and scheduler phase for weekly reset", () => {
  const text = __test.buildAnnouncementWhenItFiresText(
    "weekly-reset",
    {
      trigger: "Every Wednesday 17:00 VN.",
      dedup: "Once per week",
      messageTtl: "30 phút",
      channelOverridable: true,
    },
    { enabled: true, channelId: null },
    { raidChannelId: "123" },
    new Date(Date.UTC(2026, 3, 23, 12, 30, 0, 0)),
    {
      weeklyResetStartedAtMs: Date.UTC(2026, 3, 23, 12, 17, 0, 0),
    }
  );
  assert.match(text, /\*\*Next eligible boundary:\*\*/);
  assert.match(text, /\*\*Next scheduler check:\*\*/);
});
