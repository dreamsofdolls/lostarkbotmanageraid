// Persistence for the dropped/picked encounters.db file across page
// reloads. Uses IndexedDB to store the FileSystemFileHandle - browsers
// allow handles in IDB and re-issue file access on next visit if the
// user previously granted "Allow on every visit". Persistent FSA
// permission is what makes la-utils.vercel.app feel native; we mirror.
//
// Single-entry store keyed "current". The value carries the
// discordId of the user the handle was saved under so we can detect
// "different user opened the page" and wipe accordingly. User-side
// Remove button calls clearHandle() explicitly.

"use strict";

const DB_NAME = "artist-local-sync";
const DB_VERSION = 1;
const STORE = "fileHandles";
const ENTRY_KEY = "current";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store))
      .then((v) => { result = v; })
      .catch((err) => reject(err));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Save a FileSystemFileHandle keyed under discordId so a refresh by
 * the same user can restore it. Replaces any existing entry.
 */
export async function saveHandle({ discordId, handle, fileName }) {
  if (!handle) return;
  await withStore("readwrite", (store) => {
    store.put({ discordId, handle, fileName, savedAt: Date.now() }, ENTRY_KEY);
  });
}

/**
 * Read the stored entry. Returns `{ discordId, handle, fileName,
 * savedAt }` or null when nothing is saved.
 */
export async function loadEntry() {
  return withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(ENTRY_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  });
}

/** Wipe the stored entry. Used by the "Remove file" UI + the
 *  cross-user clear path. */
export async function clearHandle() {
  await withStore("readwrite", (store) => {
    store.delete(ENTRY_KEY);
  });
}

/**
 * Try to restore the saved handle for the given discordId. Returns:
 *   - { handle, fileName, granted: true } when permission is already
 *     granted (no user gesture needed, can read immediately)
 *   - { handle, fileName, granted: false } when permission is "prompt"
 *     or "denied" - caller must wire a button click that calls
 *     `handle.requestPermission({ mode: "read" })` in user-gesture
 *     context to elevate permission
 *   - null when no entry / wrong user / handle is bad
 *
 * Side effect: when the stored entry's discordId mismatches the
 * current one, the entry is wiped. Matches the user requirement
 * "different user opens new token => old file is dropped".
 */
export async function tryRestoreForUser(currentDiscordId) {
  if (!currentDiscordId) return null;
  let entry;
  try {
    entry = await loadEntry();
  } catch {
    return null;
  }
  if (!entry || !entry.handle) return null;
  if (entry.discordId && entry.discordId !== currentDiscordId) {
    // Different user signed in via a fresh /raid-auto-manage local-on
    // link. Wipe the previous user's handle.
    await clearHandle().catch(() => {});
    return null;
  }
  // Defensive: handle may have been invalidated (file deleted, drive
  // unmounted, etc). queryPermission throws on invalid handles in some
  // Chromium versions; catch + treat as "no restore".
  let permission;
  try {
    permission = await entry.handle.queryPermission({ mode: "read" });
  } catch {
    return null;
  }
  return {
    handle: entry.handle,
    fileName: entry.fileName || "",
    granted: permission === "granted",
  };
}
