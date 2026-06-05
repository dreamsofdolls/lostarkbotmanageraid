"use strict";

function splitCustomId(customId) {
  return String(customId || "").split(":");
}

function customIdPart(customId, index, fallback = "") {
  const part = splitCustomId(customId)[index];
  return part === undefined ? fallback : part;
}

module.exports = {
  customIdPart,
  splitCustomId,
};
