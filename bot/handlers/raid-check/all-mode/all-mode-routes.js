"use strict";

const RAID_CHECK_ALL_COMPONENT_ACTION = Object.freeze({
  userFilter: "userFilter",
  raidFilter: "raidFilter",
  viewToggle: "viewToggle",
  page: "page",
  rosterRefresh: "rosterRefresh",
  teamsSelect: "teamsSelect",
});

function splitCustomId(customId) {
  return String(customId || "").split(":");
}

function getRaidCheckAllComponentRoute(customId, { teamsSelectPrefix = "" } = {}) {
  const id = String(customId || "");
  if (!id) return null;

  if (id === "raid-check-all-filter:user") {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.userFilter,
      updatesMainMessage: true,
    };
  }
  if (id === "raid-check-all-filter:raid") {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter,
      updatesMainMessage: true,
    };
  }
  if (id.startsWith("raid-check-all:view-toggle:")) {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.viewToggle,
      targetView: splitCustomId(id)[2] || "",
      updatesMainMessage: true,
    };
  }
  if (id.startsWith("raid-check-all-page:")) {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.page,
      pageAction: splitCustomId(id)[1] || "",
      updatesMainMessage: true,
    };
  }
  if (id === "raid-check-all:roster-refresh") {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.rosterRefresh,
      updatesMainMessage: true,
    };
  }
  if (teamsSelectPrefix && id.startsWith(teamsSelectPrefix)) {
    return {
      customId: id,
      action: RAID_CHECK_ALL_COMPONENT_ACTION.teamsSelect,
      updatesMainMessage: false,
    };
  }

  return null;
}

module.exports = {
  RAID_CHECK_ALL_COMPONENT_ACTION,
  getRaidCheckAllComponentRoute,
};
