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

// Automatic support-detail reads have exhausted 512 MB containers before the
// screenshot stage. On larger containers, reserve room for another detail
// render as well as the final screenshot; this is not an OOM guarantee.
const SUPPORT_DETAIL_MIN_LIMIT = 512 * 1024 * 1024;
const SUPPORT_DETAIL_HEADROOM = 256 * 1024 * 1024;

function canCollectSupportShares(memory) {
  const limit = Number(memory.max);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const current = Number(memory.current);
  return limit > SUPPORT_DETAIL_MIN_LIMIT
    && (!Number.isFinite(current) || limit - current >= SUPPORT_DETAIL_HEADROOM);
}

module.exports = { readCaptureMemory, canCollectSupportShares };
