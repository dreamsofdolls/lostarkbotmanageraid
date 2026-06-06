"use strict";

const { normalizeName } = require("../common/shared");

module.exports = {
  ...require("./shared-tasks/config"),
  ...require("./shared-tasks/state"),
  ...require("./shared-tasks/schedule"),
  ...require("./shared-tasks/display"),
  normalizeName,
};
