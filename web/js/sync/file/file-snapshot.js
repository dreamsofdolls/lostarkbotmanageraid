"use strict";

const SNAPSHOT_DIR_NAME = "artist-local-sync-snapshots";
const PROFILE_SNAPSHOT_FILE_NAME = "encounters-profile-snapshot.db";
const FALLBACK_CHUNK_BYTES = 8 * 1024 * 1024;

function chunkByteLength(chunk) {
  if (!chunk) return 0;
  if (typeof chunk.byteLength === "number") return chunk.byteLength;
  if (typeof chunk.length === "number") return chunk.length;
  if (typeof chunk.size === "number") return chunk.size;
  return 0;
}

async function writeFileToWritable(file, writable, onProgress) {
  let written = 0;
  const total = Number(file?.size) || 0;

  if (typeof file?.stream === "function") {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += chunkByteLength(value);
        onProgress?.({ phase: "copying", written, total });
      }
    } finally {
      reader.releaseLock?.();
    }
    return written;
  }

  if (typeof file?.slice !== "function") {
    throw new Error("File stream/slice API is unavailable");
  }

  for (let offset = 0; offset < total; offset += FALLBACK_CHUNK_BYTES) {
    const chunk = await file.slice(offset, Math.min(offset + FALLBACK_CHUNK_BYTES, total)).arrayBuffer();
    await writable.write(chunk);
    written += chunkByteLength(chunk);
    onProgress?.({ phase: "copying", written, total });
  }
  return written;
}

export async function createStableFileSnapshot(file, {
  storage = globalThis.navigator?.storage,
  snapshotName = PROFILE_SNAPSHOT_FILE_NAME,
  onProgress = null,
} = {}) {
  if (!file) {
    throw new Error("source file is required");
  }
  if (!storage || typeof storage.getDirectory !== "function") {
    return { file, snapshot: false, reason: "opfs_unavailable" };
  }

  const total = Number(file.size) || 0;
  onProgress?.({ phase: "starting", written: 0, total });
  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle(SNAPSHOT_DIR_NAME, { create: true });
  try {
    await dir.removeEntry(snapshotName);
  } catch {
    // Missing prior snapshot is fine.
  }

  const handle = await dir.getFileHandle(snapshotName, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  try {
    const written = await writeFileToWritable(file, writable, onProgress);
    await writable.close();
    closed = true;
    const snapshotFile = await handle.getFile();
    onProgress?.({ phase: "ready", written: snapshotFile.size || written, total });
    return { file: snapshotFile, snapshot: true, source: file, written };
  } catch (err) {
    if (!closed && typeof writable.abort === "function") {
      try {
        await writable.abort();
      } catch {
        // Keep the original copy failure as the surfaced error.
      }
    }
    throw err;
  }
}

export const __test = {
  SNAPSHOT_DIR_NAME,
  PROFILE_SNAPSHOT_FILE_NAME,
  chunkByteLength,
  writeFileToWritable,
};
