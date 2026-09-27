"use strict";

// A logger that accepts every call the bot makes and prints nothing.
const silentLog = { info() {}, warn() {} };

module.exports = { silentLog };
