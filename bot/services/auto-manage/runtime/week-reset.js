"use strict";

function weekResetStartMs(now = new Date()) {
  const cursor = new Date(now.getTime());
  for (let i = 0; i < 8; i += 1) {
    const day = cursor.getUTCDay();
    if (day === 3 && cursor.getUTCHours() >= 10) {
      return Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        10, 0, 0, 0
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    cursor.setUTCHours(23, 59, 59, 999);
  }
  return now.getTime() - 7 * 24 * 60 * 60 * 1000;
}

module.exports = {
  weekResetStartMs,
};
