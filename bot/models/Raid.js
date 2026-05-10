"use strict";

// Backward-compatible import path. Raid metadata is domain catalog data,
// not a Mongo model; new code should import from ../domain/raid-catalog.
module.exports = require("../domain/raid-catalog");
