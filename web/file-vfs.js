// Read-only async VFS for wa-sqlite that streams from a browser File
// object via file.slice() instead of materializing the whole DB into a
// single ArrayBuffer.
//
// Why this exists: sql.js (the previous library) requires the entire DB
// passed as a Uint8Array to its constructor. For LOA Logs encounters.db
// files in the multi-GB range, that single buffer blows past Chrome's
// ArrayBuffer cap (~2 GB practical limit) and the read fails with
// NotReadableError. wa-sqlite supports async VFS with asyncify; SQLite
// only fetches the B-tree pages it needs for a query (typically a few
// MB even for a 4 GB DB), so file.slice() reads work fine.
//
// Read-only by design - we never write to the user's encounters.db file.
// jWrite / jTruncate / jSync return SQLITE_READONLY so any accidental
// write attempt fails loudly instead of silently corrupting.

import { FacadeVFS } from "https://cdn.jsdelivr.net/npm/wa-sqlite@latest/src/FacadeVFS.js";
import * as VFS from "https://cdn.jsdelivr.net/npm/wa-sqlite@latest/src/VFS.js";

export class FileBackedVFS extends FacadeVFS {
  // Two maps mirror MemoryVFS pattern: one keyed by SQLite filename
  // (so SQLite can ask "do you have a file called X?"), one keyed by
  // the runtime fileId SQLite hands out at open time.
  mapNameToFile = new Map();
  mapIdToFile = new Map();

  static async create(name, module, registeredFiles = {}) {
    const vfs = new FileBackedVFS(name, module);
    // Pre-register each name->File so SQLite open_v2(name) can find it
    // without hitting the filesystem. Caller passes:
    //   { "encounters.db": <File>, "encounters.db-journal": null, ... }
    for (const [pathname, file] of Object.entries(registeredFiles)) {
      vfs.mapNameToFile.set(pathname, file);
    }
    await vfs.isReady();
    return vfs;
  }

  constructor(name, module) {
    super(name, module);
  }

  async close() {
    for (const fileId of this.mapIdToFile.keys()) {
      await this.jClose(fileId);
    }
  }

  async jOpen(filename, fileId, flags, pOutFlags) {
    // Strip any leading "file://" or directory prefix; FacadeVFS canonicalizes
    // the input but URL-style paths still need normalizing.
    const url = new URL(filename || "", "file:///");
    const pathname = url.pathname.replace(/^\/+/, "");
    const file = this.mapNameToFile.get(pathname);
    if (!file) {
      // SQLite probes for sidecar files (-journal, -wal, -shm) it doesn't
      // strictly need for read-only access. Refusing them is correct -
      // SQLite falls back to in-memory journaling.
      return VFS.SQLITE_CANTOPEN;
    }
    this.mapIdToFile.set(fileId, { file, pathname, flags });
    pOutFlags.setInt32(0, flags, true);
    return VFS.SQLITE_OK;
  }

  async jClose(fileId) {
    this.mapIdToFile.delete(fileId);
    return VFS.SQLITE_OK;
  }

  async jRead(fileId, pData, iOffset) {
    const entry = this.mapIdToFile.get(fileId);
    if (!entry) return VFS.SQLITE_IOERR;
    const file = entry.file;
    const fileSize = file.size;
    const bgn = Math.min(iOffset, fileSize);
    const end = Math.min(iOffset + pData.byteLength, fileSize);
    const nBytes = end - bgn;
    if (nBytes > 0) {
      // file.slice() is the entire trick. Browser only reads the
      // requested byte range from disk; for a 4 GB file SQLite typically
      // touches under 100 MB total across all pages it traverses.
      const buffer = await file.slice(bgn, end).arrayBuffer();
      pData.set(new Uint8Array(buffer), 0);
    }
    if (nBytes < pData.byteLength) {
      // SQLite expects the buffer to be zero-padded when the read goes
      // past EOF, plus a SHORT_READ status so it knows to stop iterating.
      pData.fill(0, nBytes);
      return VFS.SQLITE_IOERR_SHORT_READ;
    }
    return VFS.SQLITE_OK;
  }

  // Write paths refuse - this VFS is for reading user-supplied files
  // ONLY. If SQLite somehow tries to write, surface a hard error so the
  // failure is visible in the console rather than silently no-op'd.
  async jWrite(_fileId, _pData, _iOffset) {
    return VFS.SQLITE_READONLY;
  }

  async jTruncate(_fileId, _iSize) {
    return VFS.SQLITE_READONLY;
  }

  async jSync(_fileId, _flags) {
    return VFS.SQLITE_OK;
  }

  async jFileSize(fileId, pSize64) {
    const entry = this.mapIdToFile.get(fileId);
    if (!entry) return VFS.SQLITE_IOERR;
    pSize64.setBigInt64(0, BigInt(entry.file.size), true);
    return VFS.SQLITE_OK;
  }

  async jLock(_fileId, _lockType) {
    return VFS.SQLITE_OK;
  }

  async jUnlock(_fileId, _lockType) {
    return VFS.SQLITE_OK;
  }

  async jCheckReservedLock(_fileId, pResOut) {
    // No reserved locks because no writers - ever.
    pResOut.setInt32(0, 0, true);
    return VFS.SQLITE_OK;
  }

  async jFileControl(_fileId, _op, _pArg) {
    // Don't claim to support any file controls. SQLite tries a handful
    // of optional ones (e.g. SQLITE_FCNTL_PRAGMA) and accepts NOTFOUND
    // gracefully.
    return VFS.SQLITE_NOTFOUND;
  }

  jSectorSize(_fileId) {
    // Default page size is fine. SQLite will pick its own page size
    // from the DB header on first read.
    return 0;
  }

  jDeviceCharacteristics(_fileId) {
    // SQLITE_IOCAP_IMMUTABLE = 0x00002000. Tells SQLite the file is
    // never going to change, which lets it skip a few cache-coherency
    // operations and treat reads as cacheable.
    return 0x00002000;
  }

  async jDelete(_name, _syncDir) {
    return VFS.SQLITE_READONLY;
  }

  async jAccess(name, _flags, pResOut) {
    const url = new URL(name || "", "file:///");
    const pathname = url.pathname.replace(/^\/+/, "");
    pResOut.setInt32(0, this.mapNameToFile.has(pathname) ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }

  async jFullPathname(name, pOut) {
    // Identity transform - we don't have a real directory tree.
    // FacadeVFS marshals the string into pOut for us.
    return name;
  }
}
