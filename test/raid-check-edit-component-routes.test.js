"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_CHECK_EDIT_COMPONENT_ACTION,
  getRaidCheckEditComponentRoute,
  parseRaidCheckEditComponentCustomId,
} = require("../bot/handlers/raid-check/edit-ui/component-routes");

test("raid-check edit component parser keeps prefix, action, and value slots", () => {
  assert.deepEqual(parseRaidCheckEditComponentCustomId("raid-check-edit:gate:G2"), {
    prefix: "raid-check-edit",
    action: "gate",
    value: "G2",
    parts: ["raid-check-edit", "gate", "G2"],
  });
});

test("raid-check edit component routes classify select actions", () => {
  assert.deepEqual(getRaidCheckEditComponentRoute("raid-check-edit:raid"), {
    customId: "raid-check-edit:raid",
    action: "raid",
    handler: RAID_CHECK_EDIT_COMPONENT_ACTION.raid,
  });
  assert.equal(
    getRaidCheckEditComponentRoute("raid-check-edit:user").handler,
    RAID_CHECK_EDIT_COMPONENT_ACTION.user
  );
  assert.equal(
    getRaidCheckEditComponentRoute("raid-check-edit:char").handler,
    RAID_CHECK_EDIT_COMPONENT_ACTION.char
  );
});

test("raid-check edit component routes preserve status and gate values", () => {
  assert.deepEqual(getRaidCheckEditComponentRoute("raid-check-edit:status:process"), {
    customId: "raid-check-edit:status:process",
    action: "status",
    handler: RAID_CHECK_EDIT_COMPONENT_ACTION.status,
    statusType: "process",
  });
  assert.deepEqual(getRaidCheckEditComponentRoute("raid-check-edit:gate:G3"), {
    customId: "raid-check-edit:gate:G3",
    action: "gate",
    handler: RAID_CHECK_EDIT_COMPONENT_ACTION.gate,
    gate: "G3",
  });
});

test("raid-check edit component routes handle cancel and reject unrelated custom ids", () => {
  assert.deepEqual(getRaidCheckEditComponentRoute("raid-check-edit:cancel"), {
    customId: "raid-check-edit:cancel",
    action: "cancel",
    handler: RAID_CHECK_EDIT_COMPONENT_ACTION.cancel,
  });
  assert.equal(getRaidCheckEditComponentRoute("raid-check:edit:serca_hard"), null);
  assert.equal(getRaidCheckEditComponentRoute("raid-check-edit:nope"), null);
});
