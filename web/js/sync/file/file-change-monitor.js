// Near-realtime change detection for a persisted encounters.db handle.
//
// FileSystemObserver is used as a best-effort fast path when Chromium
// exposes it. A lightweight revision poll remains active as the reliable
// fallback because the observer API is still experimental and background
// tabs may miss or delay events. The revision includes SQLite's own file
// change counter, so same-size writes are still detected even when the
// browser rounds File.lastModified.

"use strict";

// Revision reads touch only File metadata + SQLite's first 100 bytes. Polling
// this often is cheap, while it keeps the fallback path responsive on browsers
// without FileSystemObserver (or when the observer misses a background event).
export const DEFAULT_VISIBLE_POLL_MS = 300;
export const DEFAULT_HIDDEN_POLL_MS = 2_000;
export const DEFAULT_SETTLE_MS = 120;
export const DEFAULT_RETRY_MS = 750;

const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasSqliteMagic(bytes) {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  return SQLITE_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Read a cheap, stable identity for the current on-disk SQLite snapshot.
 * Only the first 100 bytes are touched, regardless of database size.
 */
export async function readFileRevision(file) {
  if (!file || typeof file.slice !== "function") {
    throw new TypeError("file with slice() required");
  }

  const size = Math.max(0, finiteNumber(file.size));
  const lastModified = Math.max(0, finiteNumber(file.lastModified));
  const revision = {
    size,
    lastModified,
    sqlite: false,
    writeVersion: null,
    changeCounter: null,
    versionValidFor: null,
  };
  if (size < SQLITE_MAGIC.length) return Object.freeze(revision);

  const end = Math.min(size, SQLITE_HEADER_BYTES);
  const buffer = await file.slice(0, end).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!hasSqliteMagic(bytes)) return Object.freeze(revision);

  revision.sqlite = true;
  if (bytes.length > 18) revision.writeVersion = bytes[18];
  if (bytes.length >= 28) {
    revision.changeCounter = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(24, false);
  }
  if (bytes.length >= 96) {
    revision.versionValidFor = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(92, false);
  }
  return Object.freeze(revision);
}

export function fileRevisionKey(revision) {
  if (!revision) return "";
  return [
    finiteNumber(revision.size),
    finiteNumber(revision.lastModified),
    revision.sqlite ? 1 : 0,
    revision.writeVersion ?? "-",
    revision.changeCounter ?? "-",
    revision.versionValidFor ?? "-",
  ].join(":");
}

export function sameFileRevision(left, right) {
  return fileRevisionKey(left) === fileRevisionKey(right);
}

export async function readFileHandleSnapshot(handle) {
  if (!handle || typeof handle.getFile !== "function") {
    throw new TypeError("FileSystemFileHandle with getFile() required");
  }
  const file = await handle.getFile();
  const revision = await readFileRevision(file);
  return { file, revision };
}

export async function readStableFileHandleSnapshot(handle, {
  settleMs = DEFAULT_SETTLE_MS,
  maxAttempts = 4,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  initialSnapshot = null,
} = {}) {
  // Callers that have just probed the handle can reuse that immutable snapshot
  // and avoid one redundant getFile() + header read on the latency hot path.
  let previous = initialSnapshot || await readFileHandleSnapshot(handle);
  const attempts = Math.max(1, Math.trunc(finiteNumber(maxAttempts, 1)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(Math.max(0, finiteNumber(settleMs)));
    const current = await readFileHandleSnapshot(handle);
    if (sameFileRevision(previous.revision, current.revision)) return current;
    previous = current;
  }
  return null;
}

/**
 * Serialize expensive refresh work while retaining only the newest queued
 * request. Active work receives an AbortSignal and an isCurrent() guard so
 * late network/SQLite results cannot commit over a newer file revision.
 */
export function createLatestOnlyRunner(run) {
  if (typeof run !== "function") throw new TypeError("run function required");

  let sequence = 0;
  let pending = null;
  let draining = null;
  let activeController = null;
  let idleWaiters = [];

  function resolveIdleWaiters() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function drain() {
    while (pending) {
      const item = pending;
      pending = null;
      activeController = typeof AbortController === "function"
        ? new AbortController()
        : null;
      const context = {
        id: item.id,
        signal: activeController?.signal,
        isCurrent: () => item.id === sequence,
      };
      try {
        const result = await run(item.value, context);
        item.resolve({
          status: context.isCurrent() ? "completed" : "superseded",
          result,
        });
      } catch (error) {
        if (!context.isCurrent() || error?.name === "AbortError") {
          item.resolve({ status: "superseded", result: null });
        } else {
          item.reject(error);
        }
      } finally {
        activeController = null;
      }
    }
    draining = null;
    resolveIdleWaiters();
    // A request cannot normally land between the loop and this assignment
    // because JavaScript runs this block atomically, but keep the guard for
    // custom Promise implementations and future refactors.
    if (pending && !draining) draining = drain();
  }

  function request(value) {
    const id = ++sequence;
    activeController?.abort();
    if (pending) {
      pending.resolve({ status: "superseded", result: null });
    }
    const promise = new Promise((resolve, reject) => {
      pending = { id, value, resolve, reject };
    });
    if (!draining) draining = drain();
    return promise;
  }

  function invalidate() {
    sequence += 1;
    activeController?.abort();
    if (pending) {
      pending.resolve({ status: "superseded", result: null });
      pending = null;
    }
  }

  function whenIdle() {
    if (!draining && !pending) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    request,
    invalidate,
    whenIdle,
    isIdle: () => !draining && !pending,
  };
}

/**
 * Observe one persisted file handle. Changes are coalesced until the file
 * has held the same revision for settleMs, avoiding reads in the middle of
 * an SQLite commit.
 */
export function createFileChangeMonitor({
  handle,
  onChange,
  onStatus = () => {},
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  observerCtor = globalThis.FileSystemObserver,
  readSnapshot = readFileHandleSnapshot,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  visiblePollMs = DEFAULT_VISIBLE_POLL_MS,
  hiddenPollMs = DEFAULT_HIDDEN_POLL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  retryMs = DEFAULT_RETRY_MS,
} = {}) {
  if (!handle || typeof handle.getFile !== "function") {
    throw new TypeError("FileSystemFileHandle with getFile() required");
  }
  if (typeof onChange !== "function") throw new TypeError("onChange required");
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("timer functions required");
  }

  let running = false;
  let pollTimer = null;
  let settleTimer = null;
  let observer = null;
  let probePromise = null;
  let probeAgain = false;
  let lastRevisionKey = "";
  let candidate = null;
  let candidateSerial = 0;
  let emissionSerial = 0;
  const detachListeners = [];

  function report(type, details = {}) {
    try {
      onStatus({ type, ...details });
    } catch {
      // Status rendering is advisory and must never stop file monitoring.
    }
  }

  function clearTimer(timer) {
    if (timer != null) clearTimeoutFn(timer);
  }

  function nextPollDelay() {
    return documentRef?.visibilityState === "hidden"
      ? hiddenPollMs
      : visiblePollMs;
  }

  function schedulePoll(delay = nextPollDelay()) {
    clearTimer(pollTimer);
    if (!running) return;
    pollTimer = setTimeoutFn(async () => {
      pollTimer = null;
      await probe("poll");
      if (running) schedulePoll();
    }, Math.max(0, finiteNumber(delay)));
  }

  function stageCandidate(snapshot, reason) {
    const key = fileRevisionKey(snapshot?.revision);
    if (!key || key === lastRevisionKey) {
      candidate = null;
      clearTimer(settleTimer);
      settleTimer = null;
      return;
    }
    if (candidate?.key === key) {
      candidate.snapshot = snapshot;
      // A previous settle read may have failed after its timer fired. In that
      // case the candidate is still valid but no timer remains to confirm it;
      // re-arm confirmation instead of leaving realtime refresh stuck forever.
      if (settleTimer == null) {
        const serial = ++candidateSerial;
        settleTimer = setTimeoutFn(() => {
          settleTimer = null;
          void confirmCandidate(serial);
        }, Math.max(0, finiteNumber(settleMs)));
      }
      return;
    }
    candidate = { key, snapshot, reason };
    const serial = ++candidateSerial;
    clearTimer(settleTimer);
    report("detected", { snapshot, reason });
    settleTimer = setTimeoutFn(() => {
      settleTimer = null;
      void confirmCandidate(serial);
    }, Math.max(0, finiteNumber(settleMs)));
  }

  async function confirmCandidate(serial) {
    if (!running || serial !== candidateSerial || !candidate) return;
    let fresh;
    try {
      fresh = await readSnapshot(handle);
    } catch (error) {
      report("error", { error, reason: "settle" });
      schedulePoll(retryMs);
      return;
    }
    if (!running || serial !== candidateSerial || !candidate) return;
    const freshKey = fileRevisionKey(fresh.revision);
    if (freshKey !== candidate.key) {
      stageCandidate(fresh, "settle");
      return;
    }

    const stable = candidate;
    candidate = null;
    const previousKey = lastRevisionKey;
    lastRevisionKey = freshKey;
    const emission = ++emissionSerial;
    report("stable", { snapshot: fresh, reason: stable.reason });
    Promise.resolve(onChange(fresh, {
      reason: stable.reason,
      previousRevisionKey: previousKey,
    })).catch((error) => {
      // Retry the same revision only when no newer stable change has already
      // been emitted. Never roll a newer baseline back to an older key.
      if (running && emission === emissionSerial && lastRevisionKey === freshKey) {
        lastRevisionKey = previousKey;
        report("error", { error, reason: "refresh" });
        schedulePoll(retryMs);
      }
    });
  }

  async function performProbe(reason) {
    do {
      probeAgain = false;
      const snapshot = await readSnapshot(handle);
      const key = fileRevisionKey(snapshot.revision);
      if (!lastRevisionKey) {
        lastRevisionKey = key;
        report("baseline", { snapshot, reason });
      } else if (key !== lastRevisionKey) {
        stageCandidate(snapshot, reason);
      } else if (candidate) {
        stageCandidate(snapshot, reason);
      }
    } while (running && probeAgain);
  }

  async function probe(reason = "manual") {
    if (!running) return;
    if (probePromise) {
      probeAgain = true;
      return probePromise;
    }
    probePromise = performProbe(reason)
      .catch((error) => {
        report("error", { error, reason });
        schedulePoll(retryMs);
      })
      .finally(() => {
        probePromise = null;
      });
    return probePromise;
  }

  function listen(target, type, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    detachListeners.push(() => target.removeEventListener(type, handler));
  }

  function start({ baselineRevision = null } = {}) {
    if (running) return;
    running = true;
    lastRevisionKey = fileRevisionKey(baselineRevision);

    listen(documentRef, "visibilitychange", () => {
      if (documentRef?.visibilityState !== "hidden") void probe("visibility");
      schedulePoll();
    });
    for (const type of ["focus", "pageshow", "online"]) {
      listen(windowRef, type, () => void probe(type));
    }

    if (typeof observerCtor === "function") {
      try {
        observer = new observerCtor(() => void probe("observer"));
        Promise.resolve(observer.observe(handle))
          .then(() => report("observer", { active: true }))
          .catch((error) => {
            observer?.disconnect?.();
            observer = null;
            report("observer", { active: false, error });
          });
      } catch (error) {
        observer = null;
        report("observer", { active: false, error });
      }
    } else {
      report("observer", { active: false });
    }

    schedulePoll();
  }

  function stop() {
    if (!running) return;
    running = false;
    candidateSerial += 1;
    emissionSerial += 1;
    clearTimer(pollTimer);
    clearTimer(settleTimer);
    pollTimer = null;
    settleTimer = null;
    candidate = null;
    observer?.disconnect?.();
    observer = null;
    while (detachListeners.length) detachListeners.pop()();
  }

  return {
    start,
    stop,
    checkNow: probe,
    setBaseline(revision) {
      lastRevisionKey = fileRevisionKey(revision);
      candidate = null;
      candidateSerial += 1;
      emissionSerial += 1;
      clearTimer(settleTimer);
      settleTimer = null;
    },
    getLastRevisionKey: () => lastRevisionKey,
    isRunning: () => running,
  };
}
