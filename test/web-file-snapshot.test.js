const test = require("node:test");
const assert = require("node:assert/strict");

function makeStreamFile(chunks) {
  const normalized = chunks.map((chunk) => new Uint8Array(chunk));
  const size = normalized.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return {
    name: "encounters.db",
    size,
    stream() {
      return new ReadableStream({
        start(controller) {
          for (const chunk of normalized) controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };
}

function makeFakeStorage() {
  const writes = [];
  const calls = { removed: [], dirs: [], files: [] };
  let closed = false;
  let aborted = false;
  const snapshotFile = { name: "encounters-profile-snapshot.db", size: 0 };
  const writable = {
    async write(chunk) {
      writes.push(new Uint8Array(chunk));
      snapshotFile.size += chunk.byteLength;
    },
    async close() {
      closed = true;
    },
    async abort() {
      aborted = true;
    },
  };
  const handle = {
    async createWritable() {
      return writable;
    },
    async getFile() {
      return snapshotFile;
    },
  };
  const dir = {
    async removeEntry(name) {
      calls.removed.push(name);
    },
    async getFileHandle(name) {
      calls.files.push(name);
      return handle;
    },
  };
  const root = {
    async getDirectoryHandle(name) {
      calls.dirs.push(name);
      return dir;
    },
  };
  return {
    writes,
    calls,
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
    storage: {
      async getDirectory() {
        return root;
      },
    },
  };
}

test("createStableFileSnapshot copies source file into browser storage", async () => {
  const { createStableFileSnapshot, __test } = await import("../web/js/sync/file-snapshot.js");
  const fake = makeFakeStorage();
  const source = makeStreamFile([[1, 2, 3], [4, 5]]);
  const progress = [];

  const result = await createStableFileSnapshot(source, {
    storage: fake.storage,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.snapshot, true);
  assert.equal(result.file.name, __test.PROFILE_SNAPSHOT_FILE_NAME);
  assert.equal(result.file.size, 5);
  assert.equal(fake.closed, true);
  assert.equal(fake.aborted, false);
  assert.deepEqual(fake.calls.dirs, [__test.SNAPSHOT_DIR_NAME]);
  assert.deepEqual(fake.calls.files, [__test.PROFILE_SNAPSHOT_FILE_NAME]);
  assert.deepEqual([...Buffer.concat(fake.writes.map((chunk) => Buffer.from(chunk)))], [1, 2, 3, 4, 5]);
  assert.equal(progress[0].phase, "starting");
  assert.equal(progress.at(-1).phase, "ready");
});

test("createStableFileSnapshot falls back when OPFS is unavailable", async () => {
  const { createStableFileSnapshot } = await import("../web/js/sync/file-snapshot.js");
  const source = makeStreamFile([[1]]);

  const result = await createStableFileSnapshot(source, { storage: null });

  assert.equal(result.snapshot, false);
  assert.equal(result.reason, "opfs_unavailable");
  assert.equal(result.file, source);
});
