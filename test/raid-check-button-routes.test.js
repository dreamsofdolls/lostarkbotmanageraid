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
    raidRequired: false,
  });
  assert.equal(
    getRaidCheckButtonRoute("raid-check:enable-auto-self:123").handler,
    RAID_CHECK_BUTTON_HANDLER.enableAutoSelf,
  );
});

test("raid-check button routes classify manager actions that do not need raid metadata", () => {
  assert.deepEqual(getRaidCheckButtonRoute("raid-check:edit-all:456"), {
    scope: RAID_CHECK_BUTTON_SCOPE.manager,
    handler: RAID_CHECK_BUTTON_HANDLER.editAll,
    action: "edit-all",
    targetDiscordId: "456",
    preSelectedUserId: "456",
    managerRequired: true,
    raidRequired: false,
  });
  assert.equal(
    getRaidCheckButtonRoute("raid-check:view-tasks:456").handler,
    RAID_CHECK_BUTTON_HANDLER.viewTasks,
  );
});

test("raid-check button routes classify raid-scoped actions and preserve unsupported actions", () => {
  assert.deepEqual(getRaidCheckButtonRoute("raid-check:edit:armoche_normal"), {
    scope: RAID_CHECK_BUTTON_SCOPE.raid,
    handler: RAID_CHECK_BUTTON_HANDLER.edit,
    action: "edit",
    raidKey: "armoche_normal",
    managerRequired: true,
    raidRequired: true,
  });
  assert.deepEqual(getRaidCheckButtonRoute("raid-check:wat:armoche_normal"), {
    scope: RAID_CHECK_BUTTON_SCOPE.raid,
    handler: RAID_CHECK_BUTTON_HANDLER.unsupported,
    action: "wat",
    raidKey: "armoche_normal",
    managerRequired: true,
    raidRequired: true,
  });
});
