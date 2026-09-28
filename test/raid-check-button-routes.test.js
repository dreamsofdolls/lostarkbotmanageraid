"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_CHECK_BUTTON_HANDLER,
  RAID_CHECK_BUTTON_SCOPE,
  getRaidCheckButtonRoute,
  parseRaidCheckButtonCustomId,
} = require("../bot/handlers/raid-check/button-routes");

test("raid-check button route parser keeps prefix, action, and value slots", () => {
  assert.deepEqual(parseRaidCheckButtonCustomId("raid-check:sync:serca_hard"), {
    prefix: "raid-check",
    action: "sync",
    value: "serca_hard",
    parts: ["raid-check", "sync", "serca_hard"],
  });
});

test("raid-check button routes classify self actions without manager gate", () => {
  assert.deepEqual(getRaidCheckButtonRoute("raid-check:disable-auto-self:123"), {
    scope: RAID_CHECK_BUTTON_SCOPE.self,
    handler: RAID_CHECK_BUTTON_HANDLER.disableAutoSelf,
    action: "disable-auto-self",
    targetDiscordId: "123",
    managerRequired: false,
  });
  assert.equal(
    getRaidCheckButtonRoute("raid-check:enable-auto-self:123").handler,
    RAID_CHECK_BUTTON_HANDLER.enableAutoSelf,
  );
});

test("raid-check button routes classify manager actions", () => {
  const syncAll = getRaidCheckButtonRoute("raid-check:sync-all");
  assert.equal(syncAll.scope, RAID_CHECK_BUTTON_SCOPE.manager);
  assert.equal(syncAll.handler, RAID_CHECK_BUTTON_HANDLER.syncAll);
  assert.equal(syncAll.managerRequired, true);
  assert.deepEqual(getRaidCheckButtonRoute("raid-check:enable-auto-one:456"), {
    scope: RAID_CHECK_BUTTON_SCOPE.manager,
    handler: RAID_CHECK_BUTTON_HANDLER.enableAutoOne,
    action: "enable-auto-one",
    targetDiscordId: "456",
    managerRequired: true,
  });
});

test("raid-check button routes keep old per-raid Sync and unknown actions Manager-gated and unsupported", () => {
  for (const [customId, action] of [
    ["raid-check:sync:armoche_normal", "sync"],
    ["raid-check:wat:armoche_normal", "wat"],
  ]) {
    assert.deepEqual(getRaidCheckButtonRoute(customId), {
      scope: RAID_CHECK_BUTTON_SCOPE.manager,
      handler: RAID_CHECK_BUTTON_HANDLER.unsupported,
      action,
      managerRequired: true,
    });
  }
});
