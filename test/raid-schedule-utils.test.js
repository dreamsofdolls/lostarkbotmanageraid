const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getTargetDayKeyForLang,
  getCurrentHourForLang,
  isInArtistQuietHoursForLang,
  hasReachedArtistWakeupBoundaryForLang,
} = require("../bot/utils/raid/schedule/artist-clock");
const {
  MAINTENANCE_TICK_MS,
  getMaintenanceSlotForNow,
  getMaintenanceSlotConfigSnapshot,
  buildMaintenanceConfigQuery,
} = require("../bot/utils/raid/schedule/maintenance");
const { dailyResetStartMs } = require("../bot/utils/raid/schedule/reset-windows");

test("artist-clock resolves per-language local day and hour", () => {
  const instant = new Date(Date.UTC(2026, 3, 23, 20, 0, 0, 0));

  assert.equal(getTargetDayKeyForLang(instant, "vi"), "2026-04-24");
  assert.equal(getCurrentHourForLang(instant, "vi"), 3);
  assert.equal(getTargetDayKeyForLang(instant, "jp"), "2026-04-24");
  assert.equal(getCurrentHourForLang(instant, "jp"), 5);
  assert.equal(getTargetDayKeyForLang(instant, "en"), "2026-04-23");
  assert.equal(getCurrentHourForLang(instant, "en"), 20);
});

test("artist-clock quiet window and wakeup boundary are locale-aware", () => {
  const quietVi = new Date(Date.UTC(2026, 3, 23, 20, 30, 0, 0)); // 03:30 VN
  const wakeupVi = new Date(Date.UTC(2026, 3, 24, 1, 0, 0, 0)); // 08:00 VN

  assert.equal(isInArtistQuietHoursForLang(quietVi, "vi"), true);
  assert.equal(hasReachedArtistWakeupBoundaryForLang(quietVi, "vi"), false);
  assert.equal(isInArtistQuietHoursForLang(wakeupVi, "vi"), false);
  assert.equal(hasReachedArtistWakeupBoundaryForLang(wakeupVi, "vi"), true);
});

test("maintenance helper exposes the Wednesday 14:00 VN schedule shape", () => {
  assert.equal(MAINTENANCE_TICK_MS, 60 * 1000);
  assert.deepEqual(getMaintenanceSlotConfigSnapshot(), {
    dayOfWeek: 3,
    utcHour: 7,
    utcMinute: 0,
    earlyMinutes: [180, 120, 60],
    countdownMinutes: [15, 10, 5, 1],
  });

  const tMinusOneHour = new Date(Date.UTC(2026, 3, 22, 6, 0, 0, 0)); // Wed 13:00 VN
  const slot = getMaintenanceSlotForNow(tMinusOneHour);
  assert.equal(slot?.group, "early");
  assert.equal(slot?.slot.key, "T-1h");
});

test("maintenance query keeps override channels eligible without monitor channel", () => {
  assert.deepEqual(buildMaintenanceConfigQuery(), {
    $or: [
      { raidChannelId: { $ne: null } },
      { "announcements.maintenanceEarly.channelId": { $ne: null } },
      { "announcements.maintenanceCountdown.channelId": { $ne: null } },
    ],
  });
});

test("dailyResetStartMs snaps to the last 10:00 UTC boundary", () => {
  assert.equal(
    dailyResetStartMs(new Date(Date.UTC(2026, 3, 22, 9, 59, 0, 0))),
    Date.UTC(2026, 3, 21, 10, 0, 0, 0)
  );
  assert.equal(
    dailyResetStartMs(new Date(Date.UTC(2026, 3, 22, 10, 0, 0, 0))),
    Date.UTC(2026, 3, 22, 10, 0, 0, 0)
  );
});
