"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_CHECK_ALL_COMPONENT_ACTION,
  getRaidCheckAllComponentRoute,
} = require("../bot/handlers/raid-check/all-mode/all-mode-routes");

test("raid-check all-mode routes exact filter custom ids", () => {
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-filter:user"), {
    customId: "raid-check-all-filter:user",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.userFilter,
    updatesMainMessage: true,
  });
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-filter:raid"), {
    customId: "raid-check-all-filter:raid",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter,
    updatesMainMessage: true,
  });
});

test("raid-check all-mode routes view toggle and pagination payloads", () => {
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all:view-toggle:task"), {
    customId: "raid-check-all:view-toggle:task",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.viewToggle,
    targetView: "task",
    updatesMainMessage: true,
  });
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-page:next"), {
    customId: "raid-check-all-page:next",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.page,
    pageAction: "next",
    updatesMainMessage: true,
  });
});

test("raid-check all-mode routes team selects only when prefix is supplied", () => {
  assert.equal(getRaidCheckAllComponentRoute("raid-check-all-teams:0"), null);
  assert.deepEqual(
    getRaidCheckAllComponentRoute("raid-check-all-teams:0", {
      teamsSelectPrefix: "raid-check-all-teams:",
    }),
    {
      customId: "raid-check-all-teams:0",
      action: RAID_CHECK_ALL_COMPONENT_ACTION.teamsSelect,
      updatesMainMessage: false,
    },
  );
});

test("raid-check all-mode routes ignore non-owned component ids", () => {
  assert.equal(getRaidCheckAllComponentRoute("raid-check:edit-all:123"), null);
  assert.equal(getRaidCheckAllComponentRoute("other-bot:thing"), null);
  assert.equal(getRaidCheckAllComponentRoute(""), null);
});
