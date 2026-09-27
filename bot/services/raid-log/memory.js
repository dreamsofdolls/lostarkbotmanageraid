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

module.exports = { readCaptureMemory };
