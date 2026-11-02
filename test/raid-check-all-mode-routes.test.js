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
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-filter:roster"), {
    customId: "raid-check-all-filter:roster",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.rosterFilter,
    updatesMainMessage: true,
  });
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-filter:raid"), {
    customId: "raid-check-all-filter:raid",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter,
    updatesMainMessage: true,
  });
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-filter:status"), {
    customId: "raid-check-all-filter:status",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.statusFilter,
    updatesMainMessage: true,
  });
});

test("raid-check all-mode routes pagination and roster refresh", () => {
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all-page:next"), {
    customId: "raid-check-all-page:next",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.page,
    pageAction: "next",
    updatesMainMessage: true,
  });
  assert.deepEqual(getRaidCheckAllComponentRoute("raid-check-all:roster-refresh"), {
    customId: "raid-check-all:roster-refresh",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.rosterRefresh,
    updatesMainMessage: true,
  });
});

test("raid-check all-mode no longer routes the retired teams select", () => {
  assert.equal(RAID_CHECK_ALL_COMPONENT_ACTION.teamsSelect, undefined);
  assert.equal(getRaidCheckAllComponentRoute("raid-check-all-teams:0"), null);
});

test("raid-check all-mode routes ignore non-owned component ids", () => {
  assert.equal(getRaidCheckAllComponentRoute("raid-check:edit-all:123"), null);
  assert.equal(getRaidCheckAllComponentRoute("other-bot:thing"), null);
  assert.equal(getRaidCheckAllComponentRoute(""), null);
});
