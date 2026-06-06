"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { buildAccountTaskFields } = require("../../../utils/raid/tasks/task-view");
const {
  getVisibleSharedTasks,
  getSharedTaskDisplay,
} = require("../../../utils/raid/tasks/shared-tasks");
const { t } = require("../../../services/i18n");
const { createTaskFilterState } = require("./task-ui/filters");
const { createTaskViewEmbedBuilder } = require("./task-ui/embed");
const { createSharedTaskToggleRow } = require("./task-ui/shared-row");
const { createViewToggleRow } = require("./task-ui/view-row");
const { createTaskToggleRows } = require("./task-ui/toggle-rows");

function createRaidStatusTaskUi(deps) {
  const context = {
    ...deps,
    lang: deps.lang || "vi",
    getClassEmoji,
    buildAccountTaskFields,
    getVisibleSharedTasks,
    getSharedTaskDisplay,
    t,
  };
  const filterState = createTaskFilterState(context);
  const { buildTaskCharFilterRow, buildTaskToggleRow } = createTaskToggleRows({
    ...context,
    filterState,
  });

  return {
    ALL_CHARS_SENTINEL: filterState.ALL_CHARS_SENTINEL,
    buildTaskViewEmbed: createTaskViewEmbedBuilder(context),
    buildViewToggleRow: createViewToggleRow(context),
    buildSharedTaskToggleRow: createSharedTaskToggleRow(context),
    charsWithTasksOnPage: filterState.charsWithTasksOnPage,
    resolveTaskCharFilter: filterState.resolveTaskCharFilter,
    aggregateTasksOnPage: filterState.aggregateTasksOnPage,
    buildTaskCharFilterRow,
    buildTaskToggleRow,
  };
}

module.exports = { createRaidStatusTaskUi };
