const test = require("node:test");
const assert = require("node:assert/strict");

const { slotCountsForSize } = require("../bot/services/raid/schedule/slot-config");

test("slotCountsForSize: 4-man is 1 support + 3 dps", () => {
  assert.deepEqual(slotCountsForSize(4), { supSlots: 1, dpsSlots: 3 });
});

test("slotCountsForSize: 8-man is 2 support + 6 dps", () => {
  assert.deepEqual(slotCountsForSize(8), { supSlots: 2, dpsSlots: 6 });
});

test("slotCountsForSize: rejects unsupported sizes", () => {
  assert.throws(() => slotCountsForSize(6), /unsupported party size/);
  assert.throws(() => slotCountsForSize(0), /unsupported party size/);
});
