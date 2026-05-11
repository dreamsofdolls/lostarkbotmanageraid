"use strict";

function dailyResetStartMs(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const boundaryMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    10,
    0,
    0,
    0
  );
  return date.getTime() >= boundaryMs
    ? boundaryMs
    : boundaryMs - 24 * 60 * 60 * 1000;
}

module.exports = {
  dailyResetStartMs,
};
