"use strict";

function appendOverflowLine(lines, total, limit, label = "more") {
  const extra = Math.max(0, Number(total) - Number(limit));
  if (extra > 0) lines.push(`\`…\` +${extra} ${label}`);
  return lines;
}

function sliceMapWithOverflow(items, limit, mapper, label = "more") {
  const list = Array.isArray(items) ? items : [];
  const lines = list.slice(0, limit).map(mapper);
  return appendOverflowLine(lines, list.length, limit, label);
}

module.exports = {
  appendOverflowLine,
  sliceMapWithOverflow,
};
