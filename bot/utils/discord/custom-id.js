"use strict";

function splitCustomId(customId) {
  return String(customId || "").split(":");
}

function customIdPart(customId, index, fallback = "") {
  const part = splitCustomId(customId)[index];
  return part === undefined ? fallback : part;
}

function parseCustomIdRoute(customId) {
  const parts = splitCustomId(customId);
  return {
    prefix: parts[0] || "",
    action: parts[1] || "",
    value: parts[2] || "",
    parts,
  };
}

module.exports = {
  customIdPart,
  parseCustomIdRoute,
  splitCustomId,
};
