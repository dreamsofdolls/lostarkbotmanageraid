"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUS_COMPONENT_ACTION,
  getEditDrivenStatusComponentIds,
  getStatusComponentRoute,
} = require("../bot/handlers/raid-status/components/component-routes");

test("raid-status component routes resolve edit-driven controls", () => {
  const editDrivenIds = getEditDrivenStatusComponentIds();

  assert.deepEqual(
    getStatusComponentRoute("status:prev"),
    {
      customId: "status:prev",
      action: STATUS_COMPONENT_ACTION.prev,
      editDriven: true,
      redraw: true,
    },
  );
  assert.deepEqual(
    getStatusComponentRoute("status-filter:raid"),
    {
      customId: "status-filter:raid",
      action: STATUS_COMPONENT_ACTION.raidFilter,
      editDriven: true,
      redraw: true,
    },
  );
  assert.deepEqual(
    getStatusComponentRoute("status-filter:roster"),
    {
      customId: "status-filter:roster",
      action: STATUS_COMPONENT_ACTION.rosterFilter,
      editDriven: true,
      redraw: true,
    },
  );
  assert.equal(editDrivenIds.has("status:prev"), true);
  assert.equal(editDrivenIds.has("status-filter:roster"), true);
  assert.equal(editDrivenIds.has("status-gold:toggle"), true);
  assert.equal(editDrivenIds.has("status:sync"), false);
  assert.deepEqual(
    getStatusComponentRoute("status:solo-companion"),
    {
      customId: "status:solo-companion",
      action: STATUS_COMPONENT_ACTION.soloCompanion,
      editDriven: false,
      redraw: false,
    },
  );
  assert.equal(editDrivenIds.has("status:solo-companion"), false);
  assert.deepEqual(
    getStatusComponentRoute("status:roster-refresh"),
    {
      customId: "status:roster-refresh",
      action: STATUS_COMPONENT_ACTION.rosterRefresh,
      editDriven: false,
      redraw: false,
    },
  );
  assert.equal(editDrivenIds.has("status:roster-refresh"), false);
});

test("raid-status component routes keep task toggle ids on one action", () => {
  assert.equal(
    getStatusComponentRoute("status-task:toggle").action,
    STATUS_COMPONENT_ACTION.taskToggle,
  );
  assert.equal(
    getStatusComponentRoute("status-task:shared-toggle").action,
    STATUS_COMPONENT_ACTION.taskToggle,
  );
});

test("raid-status component routes resolve gold setup dropdowns", () => {
  assert.equal(
    getStatusComponentRoute("status-gold:char-filter").action,
    STATUS_COMPONENT_ACTION.goldCharFilter,
  );
  assert.equal(
    getStatusComponentRoute("status-gold:toggle").action,
    STATUS_COMPONENT_ACTION.goldToggle,
  );
  assert.deepEqual(
    getStatusComponentRoute("status-gold:mode"),
    {
      customId: "status-gold:mode",
      action: STATUS_COMPONENT_ACTION.goldMode,
      editDriven: true,
      redraw: true,
    },
  );
  assert.deepEqual(
    getStatusComponentRoute("status-gold:replace:abc123"),
    {
      customId: "status-gold:replace:abc123",
      action: STATUS_COMPONENT_ACTION.goldReplace,
      editDriven: true,
      redraw: true,
    },
  );
});

test("raid-status component routes resolve dynamic my-raids select id", () => {
  assert.deepEqual(
    getStatusComponentRoute("status-myraids:select", {
      myRaidsSelectId: "status-myraids:select",
    }),
    {
      customId: "status-myraids:select",
      action: STATUS_COMPONENT_ACTION.myRaidsSelect,
      editDriven: false,
      redraw: false,
    },
  );
  assert.equal(getStatusComponentRoute("status-myraids:select"), null);
});

test("raid-status component routes ignore unknown custom ids", () => {
  assert.equal(getStatusComponentRoute("status:missing"), null);
  assert.equal(getStatusComponentRoute(""), null);
  assert.equal(getStatusComponentRoute(null), null);
});
