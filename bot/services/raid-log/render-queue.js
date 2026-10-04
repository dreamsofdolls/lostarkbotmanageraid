"use strict";

const { RaidLogError } = require("./errors");

// One browser at a time. Waiting jobs expire without ever opening a page.
function createRenderQueue({ maxPending = 4 } = {}) {
  let active = false;
  const pending = [];

  function dispatch() {
    if (active || !pending.length) return;
    const job = pending.shift();
    clearTimeout(job.timer);
    active = true;
    Promise.resolve().then(() => {
      if (Date.now() >= job.deadline) throw new RaidLogError("timeout");
      return job.run();
    }).finally(() => {
      active = false;
      dispatch();
    }).then(job.resolve, job.reject);
  }

  return {
    run(run, deadline, onAccepted) {
      if (active && pending.length >= maxPending) return Promise.reject(new RaidLogError("busy"));
      return new Promise((resolve, reject) => {
        // Admission bookkeeping runs synchronously only for accepted jobs.
        onAccepted?.();
        const job = { run, deadline, resolve, reject };
        job.timer = setTimeout(() => {
          const index = pending.indexOf(job);
          if (index < 0) return;
          pending.splice(index, 1);
          reject(new RaidLogError("timeout"));
        }, Math.max(1, deadline - Date.now()));
        job.timer.unref?.();
        pending.push(job);
        dispatch();
      });
    },
  };
}

module.exports = { createRenderQueue };
