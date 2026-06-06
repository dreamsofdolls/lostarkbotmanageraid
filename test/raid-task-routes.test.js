"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_TASK_BUTTON_ACTION,
  getRaidTaskButtonRoute,
  parseRaidTaskButtonCustomId,
} = require("../bot/handlers/raid/task/routes");

test("raid-task button parser keeps raw custom id slots", () => {
  assert.deepEqual(parseRaidTaskButtonCustomId("raid-task:clear-confirm:Main%20Roster:Qiylyn"), {
    prefix: "raid-task",
    action: "clear-confirm",
    rosterText: "Main%20Roster",
    characterText: "Qiylyn",
    parts: ["raid-task", "clear-confirm", "Main%20Roster", "Qiylyn"],
  });
});

test("raid-task button route parses current roster-scoped clear confirm", () => {
  assert.deepEqual(getRaidTaskButtonRoute("raid-task:clear-confirm:Main%20Roster:Qiylyn"), {
    action: RAID_TASK_BUTTON_ACTION.clearConfirm,
    hasRoster: true,
    rosterName: "Main Roster",
    characterName: "Qiylyn",
  });
});

test("raid-task button route preserves legacy char-only clear confirm", () => {
  assert.deepEqual(getRaidTaskButtonRoute("raid-task:clear-confirm:Qiylyn"), {
    action: RAID_TASK_BUTTON_ACTION.clearConfirm,
    hasRoster: false,
    rosterName: null,
    characterName: "Qiylyn",
  });
});

test("raid-task button route classifies cancel and ignores unrelated ids", () => {
  assert.deepEqual(getRaidTaskButtonRoute("raid-task:clear-cancel"), {
    action: RAID_TASK_BUTTON_ACTION.clearCancel,
  });
  assert.equal(getRaidTaskButtonRoute("rse:join:event"), null);
  assert.equal(getRaidTaskButtonRoute("raid-task:unknown"), null);
});
