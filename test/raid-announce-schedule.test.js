// Seed RAID_MANAGER_ID before requiring bot/commands so the module-level
// boot warning doesn't fire during this test file.
process.env.RAID_MANAGER_ID = "test-manager-1,test-manager-2";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../bot/commands");

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

test("nextAnnouncementEligibleBoundaryMs advances cleanup to the next :30 slot from an exact hour", () => {
  const now = new Date(Date.UTC(2026, 3, 24, 12, 0, 0, 0));
  const next = __test.nextAnnouncementEligibleBoundaryMs("hourly-cleanup", now);
  // Cadence is 30 min (slots at :00 and :30) so next boundary from :00
  // is the same hour's :30 slot, not the next hour.
  assert.equal(next, Date.UTC(2026, 3, 24, 12, 30, 0, 0));
});

test("world-event announce preview timing uses the next T-5 boundary", () => {
  // Mon Apr 27 2026 10:00 UTC-4. Chaos Gate starts at 11:00 UTC-4,
  // so the first reminder boundary is 10:55 UTC-4 = 14:55 UTC.
  const now = new Date(Date.UTC(2026, 3, 27, 14, 0, 0, 0));
  const next = __test.nextAnnouncementEligibleBoundaryMs("world-event-reminder", now);
  assert.equal(next, Date.UTC(2026, 3, 27, 14, 55, 0, 0));
});

test("world-event announce scheduler check follows its one-minute boot phase", () => {
  const startedAt = Date.UTC(2026, 3, 27, 14, 0, 20, 0);
  const now = new Date(Date.UTC(2026, 3, 27, 14, 0, 30, 0));
  const next = __test.nextAnnouncementSchedulerCheckMs(
    "world-event-reminder",
    now,
    { worldEventStartedAtMs: startedAt }
  );
  assert.equal(next, Date.UTC(2026, 3, 27, 14, 1, 20, 0));
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

test("announcement schedule rules keep on-demand and disabled guard copy per type", () => {
  const entry = {
    trigger: "test trigger",
    dedup: "test dedup",
    messageTtl: "test ttl",
    channelOverridable: false,
  };
  const current = { enabled: true, channelId: null };
  const now = new Date(Date.UTC(2026, 3, 24, 12, 10, 0, 0));
  const cases = [
    {
      typeKey: "set-greeting",
      guildCfg: { raidChannelId: "123" },
      schedulerState: {},
      expected: /On-demand/,
    },
    {
      typeKey: "artist-bedtime",
      guildCfg: { raidChannelId: "123", autoCleanupEnabled: false },
      schedulerState: {},
      expected: /shares the cleanup scheduler/,
    },
    {
      typeKey: "stuck-nudge",
      guildCfg: { raidChannelId: "123" },
      schedulerState: { autoManageDisabled: true },
      expected: /AUTO_MANAGE_DAILY_DISABLED=true/,
    },
  ];

  for (const testCase of cases) {
    const text = __test.buildAnnouncementWhenItFiresText(
      testCase.typeKey,
      entry,
      current,
      testCase.guildCfg,
      now,
      testCase.schedulerState
    );
    assert.match(text, testCase.expected);
  }
});

test("artist schedule rules share the cleanup scheduler phase", () => {
  const now = new Date(Date.UTC(2026, 3, 24, 12, 18, 0, 0));
  const schedulerState = {
    autoCleanupStartedAtMs: Date.UTC(2026, 3, 24, 12, 17, 0, 0),
  };
  const cleanupCheck = __test.nextAnnouncementSchedulerCheckMs(
    "hourly-cleanup",
    now,
    schedulerState
  );
  assert.equal(
    __test.nextAnnouncementSchedulerCheckMs("artist-bedtime", now, schedulerState),
    cleanupCheck
  );
  assert.equal(
    __test.nextAnnouncementSchedulerCheckMs("artist-wakeup", now, schedulerState),
    cleanupCheck
  );
});
