const test = require("node:test");
const assert = require("node:assert/strict");

function makeSqliteFile({
  size = 4096,
  lastModified = 1000,
  writeVersion = 1,
  changeCounter = 1,
  versionValidFor = changeCounter,
} = {}) {
  const header = new Uint8Array(100);
  header.set(Buffer.from("SQLite format 3\0", "binary"), 0);
  header[18] = writeVersion;
  const view = new DataView(header.buffer);
  view.setUint32(24, changeCounter, false);
  view.setUint32(92, versionValidFor, false);
  return {
    name: "encounters.db",
    size,
    lastModified,
    slice(start, end) {
      const bytes = header.slice(start, Math.min(end, header.length));
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("SQLite file revision detects same-size commits through the header counter", async () => {
  const {
    fileRevisionKey,
    readFileRevision,
    sameFileRevision,
  } = await import("../web/js/sync/file/file-change-monitor.js");

  const first = await readFileRevision(makeSqliteFile({ changeCounter: 7 }));
  const second = await readFileRevision(makeSqliteFile({ changeCounter: 8 }));

  assert.equal(first.sqlite, true);
  assert.equal(first.writeVersion, 1);
  assert.equal(first.changeCounter, 7);
  assert.equal(first.versionValidFor, 7);
  assert.equal(first.size, second.size);
  assert.equal(first.lastModified, second.lastModified);
  assert.equal(sameFileRevision(first, second), false);
  assert.notEqual(fileRevisionKey(first), fileRevisionKey(second));
});

test("latest-only runner aborts stale work and commits only the newest request", async () => {
  const { createLatestOnlyRunner } = await import(
    "../web/js/sync/file/file-change-monitor.js"
  );
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const commits = [];
  const runner = createLatestOnlyRunner(async (value, context) => {
    if (value === "first") await firstGate;
    if (context.isCurrent()) commits.push(value);
    return value;
  });

  const first = runner.request("first");
  await wait(0);
  const second = runner.request("second");
  releaseFirst();

  assert.equal((await first).status, "superseded");
  assert.equal((await second).status, "completed");
  assert.deepEqual(commits, ["second"]);
  await runner.whenIdle();
  assert.equal(runner.isIdle(), true);
});

test("stable snapshot waits through active writes and returns the settled file", async () => {
  const { readStableFileHandleSnapshot } = await import(
    "../web/js/sync/file/file-change-monitor.js"
  );
  const files = [
    makeSqliteFile({ changeCounter: 20 }),
    makeSqliteFile({ changeCounter: 21 }),
    makeSqliteFile({ changeCounter: 22 }),
    makeSqliteFile({ changeCounter: 22 }),
  ];
  const handle = {
    async getFile() {
      return files.shift() || makeSqliteFile({ changeCounter: 22 });
    },
  };

  const snapshot = await readStableFileHandleSnapshot(handle, {
    settleMs: 0,
    maxAttempts: 4,
    wait: async () => {},
  });

  assert.equal(snapshot.revision.changeCounter, 22);
});

test("stable snapshot reuses an existing probe without a redundant handle read", async () => {
  const {
    readFileHandleSnapshot,
    readStableFileHandleSnapshot,
  } = await import("../web/js/sync/file/file-change-monitor.js");
  const file = makeSqliteFile({ changeCounter: 23 });
  let handleReads = 0;
  const handle = {
    async getFile() {
      handleReads += 1;
      return file;
    },
  };
  const initialSnapshot = await readFileHandleSnapshot(handle);

  const snapshot = await readStableFileHandleSnapshot(handle, {
    initialSnapshot,
    settleMs: 0,
    maxAttempts: 1,
    wait: async () => {},
  });

  assert.equal(snapshot.revision.changeCounter, 23);
  assert.equal(handleReads, 2, "one initial probe plus one stability confirmation");
});

test("default visible monitor latency stays below half a second", async () => {
  const {
    DEFAULT_SETTLE_MS,
    DEFAULT_VISIBLE_POLL_MS,
  } = await import("../web/js/sync/file/file-change-monitor.js");

  assert.ok(DEFAULT_VISIBLE_POLL_MS + DEFAULT_SETTLE_MS < 500);
});

test("file monitor coalesces a write burst and emits only the stable revision", async () => {
  const {
    createFileChangeMonitor,
    readFileRevision,
  } = await import("../web/js/sync/file/file-change-monitor.js");

  let currentFile = makeSqliteFile({ changeCounter: 10 });
  const handle = { async getFile() { return currentFile; } };
  const baselineRevision = await readFileRevision(currentFile);
  const changes = [];
  const monitor = createFileChangeMonitor({
    handle,
    onChange: async (snapshot) => changes.push(snapshot.revision.changeCounter),
    observerCtor: null,
    visiblePollMs: 60_000,
    hiddenPollMs: 60_000,
    settleMs: 12,
  });
  monitor.start({ baselineRevision });

  currentFile = makeSqliteFile({ changeCounter: 11 });
  await monitor.checkNow("test-first-write");
  await wait(3);
  currentFile = makeSqliteFile({ changeCounter: 12 });
  await monitor.checkNow("test-second-write");
  await wait(35);

  monitor.stop();
  assert.deepEqual(changes, [12]);
});

test("file monitor retries the same revision after a refresh failure", async () => {
  const {
    createFileChangeMonitor,
    readFileRevision,
  } = await import("../web/js/sync/file/file-change-monitor.js");

  let currentFile = makeSqliteFile({ changeCounter: 30 });
  const handle = { async getFile() { return currentFile; } };
  const baselineRevision = await readFileRevision(currentFile);
  let attempts = 0;
  let resolveRecovered;
  const recovered = new Promise((resolve) => { resolveRecovered = resolve; });
  const monitor = createFileChangeMonitor({
    handle,
    onChange: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient read failure");
      resolveRecovered();
    },
    observerCtor: null,
    visiblePollMs: 60_000,
    hiddenPollMs: 60_000,
    settleMs: 2,
    retryMs: 4,
  });
  monitor.start({ baselineRevision });

  currentFile = makeSqliteFile({ changeCounter: 31 });
  await monitor.checkNow("test-retry");
  await withTimeout(recovered, 1_000, "monitor did not retry refresh");

  monitor.stop();
  assert.equal(attempts, 2);
});

test("file monitor re-arms settling after a transient snapshot read failure", async () => {
  const {
    createFileChangeMonitor,
    readFileRevision,
  } = await import("../web/js/sync/file/file-change-monitor.js");

  const baselineFile = makeSqliteFile({ changeCounter: 40 });
  const changedFile = makeSqliteFile({ changeCounter: 41 });
  const baselineRevision = await readFileRevision(baselineFile);
  const changedRevision = await readFileRevision(changedFile);
  let reads = 0;
  const changes = [];
  let resolveRecovered;
  const recovered = new Promise((resolve) => { resolveRecovered = resolve; });
  const monitor = createFileChangeMonitor({
    handle: { async getFile() { return changedFile; } },
    onChange: async (snapshot) => {
      changes.push(snapshot.revision.changeCounter);
      resolveRecovered();
    },
    readSnapshot: async () => {
      reads += 1;
      if (reads === 2) throw new Error("temporary file lock");
      return { file: changedFile, revision: changedRevision };
    },
    observerCtor: null,
    visiblePollMs: 60_000,
    hiddenPollMs: 60_000,
    settleMs: 2,
    retryMs: 4,
  });
  monitor.start({ baselineRevision });

  await monitor.checkNow("test-settle-read-failure");
  await withTimeout(recovered, 1_000, "monitor did not recover settle read");

  monitor.stop();
  assert.deepEqual(changes, [41]);
  assert.equal(reads >= 4, true);
});
