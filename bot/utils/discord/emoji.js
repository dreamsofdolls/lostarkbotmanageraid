"use strict";

function parseCustomEmoji(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const match = raw.match(/^<(a?):([^:]+):(\d+)>$/);
  if (!match) return null;
  return {
    animated: match[1] === "a",
    name: match[2],
    id: match[3],
  };
}

module.exports = {
  parseCustomEmoji,
};
