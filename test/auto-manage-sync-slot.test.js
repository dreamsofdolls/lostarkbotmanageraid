"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAutoManageSyncSlotManager } = require("../bot/services/auto-manage/runtime/support/slot");

// A slot manager with no cooldown unless `lastAttempt` makes one apply.
function makeSlots({ lastAttempt = 0, cooldownMs = 0 } = {}) {
  return createAutoManageSyncSlotManager({
    User: { findOne: () => ({ lean: async () => ({ lastAutoManageAttemptAt: lastAttempt }) }) },
    getAutoManageCooldownMs: () => cooldownMs,
    defaultCooldownMs: cooldownMs,
  });
}

test("an acquired slot is freed by its own release, so the next sync can enter", async () => {
  const slots = makeSlots();
  const first = await slots.acquireAutoManageSyncSlot("user-1");
  assert.equal(first.acquired, true);
  assert.equal((await slots.acquireAutoManageSyncSlot("user-1")).reason, "in-flight");
  first.release();
  assert.equal((await slots.acquireAutoManageSyncSlot("user-1")).acquired, true);
});

test("a repeated release cannot free the slot of a sync that started after it", async () => {
  const slots = makeSlots();
  const first = await slots.acquireAutoManageSyncSlot("user-1");
  first.release();
  const second = await slots.acquireAutoManageSyncSlot("user-1");
  first.release();
  assert.equal((await slots.acquireAutoManageSyncSlot("user-1")).reason, "in-flight");
  second.release();
  assert.equal((await slots.acquireAutoManageSyncSlot("user-1")).acquired, true);
});

test("a refused acquire releases nothing, whether busy or cooling down", async () => {
  const slots = makeSlots();
  const holder = await slots.acquireAutoManageSyncSlot("user-1");
  const busy = await slots.acquireAutoManageSyncSlot("user-1");
  assert.deepEqual([busy.acquired, busy.reason], [false, "in-flight"]);
  busy.release();
  assert.equal((await slots.acquireAutoManageSyncSlot("user-1")).reason, "in-flight");
  holder.release();

  const cooling = makeSlots({ lastAttempt: Date.now(), cooldownMs: 60_000 });
  const refused = await cooling.acquireAutoManageSyncSlot("user-2");
  assert.deepEqual([refused.acquired, refused.reason], [false, "cooldown"]);
  assert.ok(refused.remainingMs > 0);
  refused.release();
  const forced = await cooling.acquireAutoManageSyncSlot("user-2", { ignoreCooldown: true });
  assert.equal(forced.acquired, true);
  assert.equal((await cooling.acquireAutoManageSyncSlot("user-2", { ignoreCooldown: true })).reason, "in-flight");
});
