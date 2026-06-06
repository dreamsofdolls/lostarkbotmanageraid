"use strict";

const STATUS_COMPONENT_ACTION = Object.freeze({
  prev: "prev",
  next: "next",
  localNewLink: "localNewLink",
  localRefresh: "localRefresh",
  sync: "sync",
  myRaidsSelect: "myRaidsSelect",
  raidFilter: "raidFilter",
  viewToggle: "viewToggle",
  taskCharFilter: "taskCharFilter",
  taskToggle: "taskToggle",
});

const STATUS_COMPONENT_ROUTES = Object.freeze([
  {
    customId: "status:prev",
    action: STATUS_COMPONENT_ACTION.prev,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status:next",
    action: STATUS_COMPONENT_ACTION.next,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status:local-new-link",
    action: STATUS_COMPONENT_ACTION.localNewLink,
    editDriven: false,
    redraw: false,
  },
  {
    customId: "status:local-refresh",
    action: STATUS_COMPONENT_ACTION.localRefresh,
    editDriven: false,
    redraw: false,
  },
  {
    customId: "status:sync",
    action: STATUS_COMPONENT_ACTION.sync,
    editDriven: false,
    redraw: false,
  },
  {
    customId: "status-filter:raid",
    action: STATUS_COMPONENT_ACTION.raidFilter,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-view:toggle",
    action: STATUS_COMPONENT_ACTION.viewToggle,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-task:char-filter",
    action: STATUS_COMPONENT_ACTION.taskCharFilter,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-task:shared-toggle",
    action: STATUS_COMPONENT_ACTION.taskToggle,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-task:toggle",
    action: STATUS_COMPONENT_ACTION.taskToggle,
    editDriven: true,
    redraw: true,
  },
]);

const ROUTES_BY_CUSTOM_ID = new Map(STATUS_COMPONENT_ROUTES.map((route) => [route.customId, route]));

function getStatusComponentRoute(customId, { myRaidsSelectId = "" } = {}) {
  const id = String(customId || "");
  if (id && id === myRaidsSelectId) {
    return Object.freeze({
      customId: id,
      action: STATUS_COMPONENT_ACTION.myRaidsSelect,
      editDriven: false,
      redraw: false,
    });
  }
  return ROUTES_BY_CUSTOM_ID.get(id) || null;
}

function getEditDrivenStatusComponentIds() {
  return new Set(STATUS_COMPONENT_ROUTES.filter((route) => route.editDriven).map((route) => route.customId));
}

module.exports = {
  STATUS_COMPONENT_ACTION,
  STATUS_COMPONENT_ROUTES,
  getEditDrivenStatusComponentIds,
  getStatusComponentRoute,
};
