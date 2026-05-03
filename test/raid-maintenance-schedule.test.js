// Seed RAID_MANAGER_ID before requiring bot/commands so the module-level
// boot warning doesn't fire during this test file.
process.env.RAID_MANAGER_ID = "test-manager-1,test-manager-2";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../bot/commands");
const {
  announcementOverridableTypeKeys,
  announcementTypeEntry,
} = require("../bot/utils/raid/announcements");

// Lost Ark VN maintenance: Wednesday 14:00 VN = Wednesday 07:00 UTC.
// All test instants below use Apr 22 2026 (a Wednesday) for the boundary
// day, so each mốc maps to a clean UTC moment:
//   T-3h    11:00 VN  = 04:00 UTC
//   T-2h    12:00 VN  = 05:00 UTC
//   T-1h    13:00 VN  = 06:00 UTC
//   T-15m   13:45 VN  = 06:45 UTC
//   T-10m   13:50 VN  = 06:50 UTC
//   T-5m    13:55 VN  = 06:55 UTC
//   T-1m    13:59 VN  = 06:59 UTC
//   14:00   14:00 VN  = 07:00 UTC (boundary itself)
const WED_UTC_HOUR_FOR_NOON_VN = 7;
const WED_DAY_OF_MONTH = 22;
function wedAt(utcHour, utcMinute = 0) {
  return new Date(Date.UTC(2026, 3, WED_DAY_OF_MONTH, utcHour, utcMinute, 0, 0));
}

test("MAINTENANCE_DAY_VN/HOUR/MINUTE constants point at Wed 14:00 VN", () => {
  assert.equal(__test.MAINTENANCE_DAY_VN, 3);
  assert.equal(__test.MAINTENANCE_HOUR_VN, 14);
  assert.equal(__test.MAINTENANCE_MINUTE_VN, 0);
});

test("getMaintenanceSlotForNow returns null on a non-Wednesday", () => {
  // Apr 23 2026 = Thursday in VN at any hour.
  const thuMidnightVn = new Date(Date.UTC(2026, 3, 22, 17, 0, 0, 0)); // 00:00 VN Thu
  assert.equal(__test.getMaintenanceSlotForNow(thuMidnightVn), null);
});

test("getMaintenanceSlotForNow returns null past the 14:00 VN boundary", () => {
  const justAfterBoundary = wedAt(WED_UTC_HOUR_FOR_NOON_VN, 1); // 14:01 VN
  assert.equal(__test.getMaintenanceSlotForNow(justAfterBoundary), null);
});

test("getMaintenanceSlotForNow returns null on a non-mốc minute (T-2h30m)", () => {
  const offMin = wedAt(4, 30); // 11:30 VN = T-2h30m, not in slot list
  assert.equal(__test.getMaintenanceSlotForNow(offMin), null);
});

test("getMaintenanceSlotForNow matches T-3h with group=early", () => {
  const result = __test.getMaintenanceSlotForNow(wedAt(4, 0)); // 11:00 VN
  assert.equal(result?.group, "early");
  assert.equal(result?.slot.key, "T-3h");
  assert.equal(result?.slot.minutesBefore, 180);
  assert.equal(result?.slot.pingHere, true);
});

test("getMaintenanceSlotForNow matches T-1h with group=early and pingHere=true", () => {
  const result = __test.getMaintenanceSlotForNow(wedAt(6, 0)); // 13:00 VN
  assert.equal(result?.group, "early");
  assert.equal(result?.slot.key, "T-1h");
  assert.equal(result?.slot.pingHere, true);
});

test("getMaintenanceSlotForNow matches T-2h with group=early and pingHere=false", () => {
  const result = __test.getMaintenanceSlotForNow(wedAt(5, 0)); // 12:00 VN
  assert.equal(result?.group, "early");
  assert.equal(result?.slot.key, "T-2h");
  assert.equal(result?.slot.pingHere, false);
});

test("getMaintenanceSlotForNow matches T-15m with group=countdown and pingHere=false", () => {
  const result = __test.getMaintenanceSlotForNow(wedAt(6, 45)); // 13:45 VN
  assert.equal(result?.group, "countdown");
  assert.equal(result?.slot.key, "T-15m");
  assert.equal(result?.slot.pingHere, false);
});

test("getMaintenanceSlotForNow matches T-1m with group=countdown", () => {
  const result = __test.getMaintenanceSlotForNow(wedAt(6, 59)); // 13:59 VN
  assert.equal(result?.group, "countdown");
  assert.equal(result?.slot.key, "T-1m");
  assert.equal(result?.slot.pingHere, false);
});

test("nextAnnouncementEligibleBoundaryMs maintenance-early picks the next T-3h on Wed", () => {
  // Mon Apr 20 2026 8:00 VN. Next Wed 11:00 VN = Apr 22 04:00 UTC.
  const monMorningVn = new Date(Date.UTC(2026, 3, 20, 1, 0, 0, 0));
  const next = __test.nextAnnouncementEligibleBoundaryMs("maintenance-early", monMorningVn);
  assert.equal(next, Date.UTC(2026, 3, WED_DAY_OF_MONTH, 4, 0, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs maintenance-early advances to T-2h once T-3h passed today", () => {
  // 11:30 VN Wed - already past T-3h (11:00) but before T-2h (12:00).
  const wedAfterT3h = wedAt(4, 30);
  const next = __test.nextAnnouncementEligibleBoundaryMs("maintenance-early", wedAfterT3h);
  // Next mốc = T-2h = 12:00 VN = 05:00 UTC.
  assert.equal(next, Date.UTC(2026, 3, WED_DAY_OF_MONTH, 5, 0, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs maintenance-countdown picks T-15m as first mốc on Wed morning", () => {
  // Wed 09:00 VN = 02:00 UTC, before any countdown mốc.
  const wedMorning = wedAt(2, 0);
  const next = __test.nextAnnouncementEligibleBoundaryMs("maintenance-countdown", wedMorning);
  // Earliest countdown = T-15m = 13:45 VN = 06:45 UTC.
  assert.equal(next, Date.UTC(2026, 3, WED_DAY_OF_MONTH, 6, 45, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs maintenance-early rolls forward 1 week after Wed boundary", () => {
  // Wed 14:01 VN = 07:01 UTC. All Wed mốc passed, next is the following Wed T-3h.
  const justAfterBoundary = wedAt(7, 1);
  const next = __test.nextAnnouncementEligibleBoundaryMs("maintenance-early", justAfterBoundary);
  const nextWed = WED_DAY_OF_MONTH + 7;
  assert.equal(next, Date.UTC(2026, 3, nextWed, 4, 0, 0, 0));
});

test("pickMaintenanceVariant returns a non-empty string from the slot pool", () => {
  for (const key of ["T-3h", "T-2h", "T-1h", "T-15m", "T-10m", "T-5m", "T-1m"]) {
    const v = __test.pickMaintenanceVariant(key);
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0, `pool for ${key} returned empty string`);
  }
});

test("pickMaintenanceVariant T-3h and T-1h variants include @here prefix", () => {
  // Drain the pool a few times and confirm every returned variant starts
  // with the ping marker - we baked it into all 3 strings of each pool.
  for (let i = 0; i < 30; i++) {
    assert.ok(__test.pickMaintenanceVariant("T-3h").startsWith("@here "));
    assert.ok(__test.pickMaintenanceVariant("T-1h").startsWith("@here "));
  }
});

test("pickMaintenanceVariant non-ping mốc never include @here", () => {
  for (let i = 0; i < 30; i++) {
    for (const key of ["T-2h", "T-15m", "T-10m", "T-5m", "T-1m"]) {
      assert.ok(
        !__test.pickMaintenanceVariant(key).includes("@here"),
        `${key} variant should not contain @here`
      );
    }
  }
});

test("buildMaintenancePreview('early') lists all 3 early mốc keys", () => {
  const preview = __test.buildMaintenancePreview("early");
  assert.match(preview, /T-3h/);
  assert.match(preview, /T-2h/);
  assert.match(preview, /T-1h/);
  // Should not list any countdown mốc in the early preview.
  assert.ok(!preview.includes("T-15m"));
});

test("buildMaintenancePreview('countdown') lists all 4 countdown mốc keys", () => {
  const preview = __test.buildMaintenancePreview("countdown");
  assert.match(preview, /T-15m/);
  assert.match(preview, /T-10m/);
  assert.match(preview, /T-5m/);
  assert.match(preview, /T-1m/);
});

test("maintenance registry preview matches the runtime ping policy", () => {
  const earlyPreview = announcementTypeEntry("maintenance-early").previewContent;
  const countdownPreview = announcementTypeEntry("maintenance-countdown").previewContent;

  assert.match(earlyPreview, /T-3h: ping @here/);
  assert.match(earlyPreview, /T-1h: ping @here/);
  assert.doesNotMatch(earlyPreview, /@everyone/);
  assert.doesNotMatch(countdownPreview, /@here|@everyone/);
});

// Tiny in-test matcher that mirrors Mongo's $or + dot-path + $ne semantics
// well enough to verify a guild config doc would survive the scheduler's
// initial filter. We're not validating Mongo itself, only that the query
// shape we hand to GuildConfig.find selects the right docs.
function docMatchesQuery(doc, query) {
  if (query.$or) return query.$or.some((sub) => docMatchesQuery(doc, sub));
  for (const [path, condition] of Object.entries(query)) {
    const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
    if (condition && typeof condition === "object" && "$ne" in condition) {
      if (value === condition.$ne || value === undefined) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

test("buildMaintenanceConfigQuery has $or with 3 channel-source paths", () => {
  const q = __test.buildMaintenanceConfigQuery();
  assert.ok(Array.isArray(q.$or), "filter must use $or");
  assert.equal(q.$or.length, 3, "filter must cover 3 channel paths");
  const paths = q.$or.map((sub) => Object.keys(sub)[0]).sort();
  assert.deepEqual(paths, [
    "announcements.maintenanceCountdown.channelId",
    "announcements.maintenanceEarly.channelId",
    "raidChannelId",
  ]);
  for (const sub of q.$or) {
    const cond = Object.values(sub)[0];
    assert.deepEqual(cond, { $ne: null });
  }
});

test("buildMaintenanceConfigQuery selects guilds with raidChannelId set (default monitor)", () => {
  const q = __test.buildMaintenanceConfigQuery();
  const doc = {
    raidChannelId: "111",
    announcements: {
      maintenanceEarly: { enabled: true, channelId: null },
      maintenanceCountdown: { enabled: true, channelId: null },
    },
  };
  assert.ok(docMatchesQuery(doc, q));
});

test("buildMaintenanceConfigQuery selects guilds with override set even when raidChannelId is null (regression)", () => {
  // The scheduler used to filter on raidChannelId only, which silently
  // dropped guilds that had configured a maintenance override channel
  // before setting the monitor. Codex round flagged that mismatch with
  // /raid-announce UX claiming set-channel works independently. This test
  // pins the fix in place.
  const q = __test.buildMaintenanceConfigQuery();
  const earlyOverrideOnly = {
    raidChannelId: null,
    announcements: {
      maintenanceEarly: { enabled: true, channelId: "222" },
      maintenanceCountdown: { enabled: true, channelId: null },
    },
  };
  const countdownOverrideOnly = {
    raidChannelId: null,
    announcements: {
      maintenanceEarly: { enabled: true, channelId: null },
      maintenanceCountdown: { enabled: true, channelId: "333" },
    },
  };
  assert.ok(docMatchesQuery(earlyOverrideOnly, q), "early override alone must select guild");
  assert.ok(docMatchesQuery(countdownOverrideOnly, q), "countdown override alone must select guild");
});

test("announcementOverridableTypeKeys returns all 4 channel-overridable types including maintenance-* (Codex bug 2)", () => {
  // The /raid-announce action:set-channel reject message used to hard-code
  // "weekly-reset và stuck-nudge", which drifted out of sync once the 2
  // maintenance types landed. Pin the dynamic registry derivation so the
  // wording stays accurate as new overridable types are added.
  const keys = announcementOverridableTypeKeys().sort();
  assert.deepEqual(keys, [
    "maintenance-countdown",
    "maintenance-early",
    "stuck-nudge",
    "weekly-reset",
  ]);
});

test("variant pools no longer contain 'dungeon' / 'hub' (tone tweak L1)", () => {
  // Earlier T-5m and T-10m variants used 'dungeon' and 'hub' which are
  // borderline English; LA VN players use 'raid' / 'thành phố'. Pin the
  // tone fix in place so a future variant edit doesn't reintroduce them.
  for (const key of ["T-3h", "T-2h", "T-1h", "T-15m", "T-10m", "T-5m", "T-1m"]) {
    // Drain the random pool a few times to cover all 3 variants in each pool.
    for (let i = 0; i < 30; i++) {
      const v = __test.pickMaintenanceVariant(key);
      assert.ok(!/\bdungeon\b/i.test(v), `${key} variant still contains 'dungeon'`);
      assert.ok(!/\bhub\b/i.test(v), `${key} variant still contains 'hub'`);
    }
  }
});

test("buildMaintenanceConfigQuery rejects guilds with neither monitor nor override set", () => {
  const q = __test.buildMaintenanceConfigQuery();
  const empty = {
    raidChannelId: null,
    announcements: {
      maintenanceEarly: { enabled: true, channelId: null },
      maintenanceCountdown: { enabled: true, channelId: null },
    },
  };
  assert.ok(!docMatchesQuery(empty, q), "guild with no destination must not be selected");
  // Legacy guild missing the announcements subdoc entirely: still rejected
  // because neither path resolves to a non-null value.
  const legacy = { raidChannelId: null };
  assert.ok(!docMatchesQuery(legacy, q));
});
