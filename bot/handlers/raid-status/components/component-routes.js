"use strict";

const STATUS_COMPONENT_ACTION = Object.freeze({
  prev: "prev",
  next: "next",
  localNewLink: "localNewLink",
  localRefresh: "localRefresh",
  soloCompanion: "soloCompanion",
  rosterRefresh: "rosterRefresh",
  sync: "sync",
  myRaidsSelect: "myRaidsSelect",
  raidFilter: "raidFilter",
  rosterFilter: "rosterFilter",
  viewToggle: "viewToggle",
  taskCharFilter: "taskCharFilter",
  taskToggle: "taskToggle",
  goldCharFilter: "goldCharFilter",
  goldMode: "goldMode",
  goldToggle: "goldToggle",
  goldReplace: "goldReplace",
  localSyncAction: "localSyncAction",
});

// `status-local:` buttons live inside the /raid-status message and are
// deliberately absent from every prefix in interaction-router-registry.js.
// The DM preview uses `local-sync:` and the global router instead · if
// both surfaces shared one prefix, a click here would make the router
// editReply() the console payload over the whole status embed.
const LOCAL_SYNC_ACTION_PREFIX = "status-local:";

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
    customId: "status:solo-companion",
    action: STATUS_COMPONENT_ACTION.soloCompanion,
    editDriven: false,
    redraw: false,
  },
  {
    customId: "status:roster-refresh",
    action: STATUS_COMPONENT_ACTION.rosterRefresh,
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
    customId: "status-filter:roster",
    action: STATUS_COMPONENT_ACTION.rosterFilter,
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
  {
    customId: "status-gold:char-filter",
    action: STATUS_COMPONENT_ACTION.goldCharFilter,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-gold:toggle",
    action: STATUS_COMPONENT_ACTION.goldToggle,
    editDriven: true,
    redraw: true,
  },
  {
    customId: "status-gold:mode",
    action: STATUS_COMPONENT_ACTION.goldMode,
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
  if (id.startsWith("status-gold:replace:")) {
    return Object.freeze({
      customId: id,
      action: STATUS_COMPONENT_ACTION.goldReplace,
      editDriven: true,
      redraw: true,
    });
  }
  if (id.startsWith(LOCAL_SYNC_ACTION_PREFIX)) {
    return Object.freeze({
      customId: id,
      action: STATUS_COMPONENT_ACTION.localSyncAction,
      editDriven: true,
      redraw: true,
    });
  }
  return ROUTES_BY_CUSTOM_ID.get(id) || null;
}

function getEditDrivenStatusComponentIds() {
  return new Set(STATUS_COMPONENT_ROUTES.filter((route) => route.editDriven).map((route) => route.customId));
}

module.exports = {
  STATUS_COMPONENT_ACTION,
  getEditDrivenStatusComponentIds,
  getStatusComponentRoute,
};
