"use strict";

const RAID_CHECK_ALL_COMPONENT_ACTION = Object.freeze({
  userFilter: "userFilter",
  rosterFilter: "rosterFilter",
  raidFilter: "raidFilter",
  statusFilter: "statusFilter",
  viewToggle: "viewToggle",
  page: "page",
  rosterRefresh: "rosterRefresh",
  teamsSelect: "teamsSelect",
});

const EXACT_COMPONENT_ACTION_BY_ID = new Map([
  ["raid-check-all-filter:user", RAID_CHECK_ALL_COMPONENT_ACTION.userFilter],
  ["raid-check-all-filter:roster", RAID_CHECK_ALL_COMPONENT_ACTION.rosterFilter],
  ["raid-check-all-filter:raid", RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter],
  ["raid-check-all-filter:status", RAID_CHECK_ALL_COMPONENT_ACTION.statusFilter],
  ["raid-check-all:roster-refresh", RAID_CHECK_ALL_COMPONENT_ACTION.rosterRefresh],
]);

const PREFIX_COMPONENT_ROUTES = Object.freeze([
  {
    prefix: "raid-check-all:view-toggle:",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.viewToggle,
    payloadKey: "targetView",
    segmentIndex: 2,
  },
  {
    prefix: "raid-check-all-page:",
    action: RAID_CHECK_ALL_COMPONENT_ACTION.page,
    payloadKey: "pageAction",
    segmentIndex: 1,
  },
]);

function splitCustomId(customId) {
  return String(customId || "").split(":");
}

function getRaidCheckAllComponentRoute(customId, { teamsSelectPrefix = "" } = {}) {
  const id = String(customId || "");
  if (!id) return null;

  const exactAction = EXACT_COMPONENT_ACTION_BY_ID.get(id);
  if (exactAction) {
    return {
      customId: id,
      action: exactAction,
      updatesMainMessage: true,
    };
  }

  const prefixRoute = PREFIX_COMPONENT_ROUTES.find((route) => id.startsWith(route.prefix));
  const route = prefixRoute || (
    teamsSelectPrefix && id.startsWith(teamsSelectPrefix)
      ? { action: RAID_CHECK_ALL_COMPONENT_ACTION.teamsSelect }
      : null
  );
  if (!route) return null;

  const payload = route.payloadKey
    ? { [route.payloadKey]: splitCustomId(id)[route.segmentIndex] || "" }
    : {};
  return {
    customId: id,
    action: route.action,
    ...payload,
    updatesMainMessage: Boolean(prefixRoute),
  };
}

module.exports = {
  RAID_CHECK_ALL_COMPONENT_ACTION,
  getRaidCheckAllComponentRoute,
};
