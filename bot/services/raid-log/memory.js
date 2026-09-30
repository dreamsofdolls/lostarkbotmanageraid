"use strict";

const { readFile } = require("node:fs/promises");

// Container-wide memory, including Chromium. Missing cgroup v2 files mean
// unavailable metrics (e.g. Windows), not zero memory use or proof of no OOM.
async function readCaptureMemory(read = readFile) {
  const names = ["current", "max", "peak", "events"];
  const readings = await Promise.allSettled(names.map(name => read(`/sys/fs/cgroup/memory.${name}`, "utf8")));
  return Object.fromEntries(readings.flatMap((result, index) => result.status === "fulfilled"
    ? [[names[index], result.value.trim().replace(/\s*\n\s*/g, "; ")]] : []));
}

// Allow for renderer growth, encoded buffers and streamed PNG scanlines.
// Framing no longer holds full decoded surfaces. This is a reserve, not an
// exact peak prediction or an OOM guarantee.
const MEMORY_RESERVE = 128 * 1024 * 1024;

/**
 * @param {{ max?: string, current?: string }} memory container byte counts
 * @returns {boolean} whether the idle browser leaves too little renderer headroom
 */
function shouldReleaseBrowser(memory) {
  const limit = Number(memory.max);
  const current = Number(memory.current);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(current) || current < 0
    || memory.current === "" || memory.current == null) return false;
  return limit - current < MEMORY_RESERVE;
}

module.exports = { readCaptureMemory, shouldReleaseBrowser };
