"use strict";

const DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const MAX_BIBLE_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_BIBLE_MAX_PENDING = 32;
const DEFAULT_BIBLE_QUEUE_WAIT_MS = 30_000;
const BIBLE_QUEUE_FULL_CODE = "BIBLE_QUEUE_FULL";

/**
 * Read a Retry-After header value as a delay.
 * @param {string|null|undefined} value - seconds or an HTTP date
 * @param {number} [nowMs] - clock used for an HTTP date
 * @returns {number|null} delay in ms, or null when the value is missing or unreadable
 */
function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

function getRetryAfterMs(response, nowMs = Date.now()) {
  const value = response?.headers?.get?.("retry-after");
  return parseRetryAfterMs(value, nowMs);
}

/**
 * Build the error thrown for a non-OK Bible response, keeping the status and
 * any Retry-After delay for BibleRequestLimiter.
 * @param {string} message
 * @param {{status?: number, headers?: {get: (name: string) => string|null}}} response
 * @param {number} [nowMs] - clock used for an HTTP-date Retry-After
 * @returns {Error} error with `status`, plus `retryAfterMs` when Bible sent one
 */
function createBibleHttpError(message, response, nowMs = Date.now()) {
  const error = new Error(message);
  error.status = Number(response?.status) || null;
  const retryAfterMs = getRetryAfterMs(response, nowMs);
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

// Every Bible HTTP error message starts with one of these and its status. A
// character name only ever comes after the status, so it is never read.
const BIBLE_HTTP_STATUS_PATTERN =
  /^(?:LostArk Bible|Bible roster page returned|Bible logs API returned) HTTP (\d{3})\b/;

/**
 * Reports keep only the error message, so a message without a `status` is
 * read for the status at its start.
 * @param {unknown} error - an Error or an error message
 * @returns {number|null} the HTTP status Bible answered with, or null
 */
function getBibleHttpStatus(error) {
  const status = Number(error?.status);
  if (status) return status;
  const match = BIBLE_HTTP_STATUS_PATTERN.exec(error?.message || String(error || ""));
  return match ? Number(match[1]) : null;
}

/**
 * @param {unknown} error - an Error or an error message
 * @returns {boolean} true for an HTTP 429, including the limiter's backoff
 */
function isBibleRateLimitError(error) {
  return getBibleHttpStatus(error) === 429;
}

/**
 * Caps concurrent Bible requests, waiting queue size and queue wait time.
 * After an HTTP 429 it rejects every queued and new request with a backoff
 * error until the backoff ends.
 */
class BibleRequestLimiter {
  /**
   * @param {number} max - requests allowed in flight at once
   * @param {{defaultBackoffMs?: number, maxPending?: number, maxQueueWaitMs?: number,
   *   nowMs?: () => number, log?: Console}} [options]
   *   `defaultBackoffMs` applies when a 429 carries no Retry-After;
   *   at most 32 requests wait for a slot, for at most 30 seconds by default.
   */
  constructor(
    max,
    {
      defaultBackoffMs = DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS,
      maxPending = DEFAULT_BIBLE_MAX_PENDING,
      maxQueueWaitMs = DEFAULT_BIBLE_QUEUE_WAIT_MS,
      nowMs = () => Date.now(),
      log = console,
    } = {}
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 0) {
      throw new RangeError("maxPending must be a non-negative integer");
    }
    if (!Number.isFinite(maxQueueWaitMs) || maxQueueWaitMs <= 0) {
      throw new RangeError("maxQueueWaitMs must be a positive finite number");
    }
    this.max = Math.max(1, Number(max) || 1);
    this.maxPending = maxPending;
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.defaultBackoffMs = Math.max(1, Number(defaultBackoffMs) || 1);
    this.nowMs = nowMs;
    this.log = log;
    this.active = 0;
    this.queue = [];
    this.blockedUntil = 0;
  }

  /** @returns {number} ms until requests are allowed again, 0 when they already are */
  getBackoffRemainingMs() {
    return Math.max(0, this.blockedUntil - this.nowMs());
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn - the Bible request
   * @param {{signal?: AbortSignal}} [options] - cancel a request while it is queued
   * @returns {Promise<T>} its result, or a backoff error while the backoff is active
   */
  run(fn, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const remainingMs = this.getBackoffRemainingMs();
    if (remainingMs > 0) {
      return Promise.reject(this._createBackoffError(remainingMs));
    }
    if (this.active >= this.max && this.queue.length >= this.maxPending) {
      return Promise.reject(Object.assign(new Error("LostArk Bible request queue is full; try again shortly"), {
        name: "BibleQueueFullError", code: BIBLE_QUEUE_FULL_CODE,
      }));
    }

    return new Promise((resolve, reject) => {
      const item = {
        fn, resolve, reject, signal,
        detach: () => {
          clearTimeout(item.timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      const remove = error => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        item.detach();
        reject(error);
      };
      const abort = () => remove(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (this.active >= this.max) {
        item.deadline = this.nowMs() + this.maxQueueWaitMs;
        item.timer = setTimeout(() => remove(this._createQueueTimeoutError()), this.maxQueueWaitMs);
        item.timer.unref?.();
      }
      this.queue.push(item);
      this._dispatch();
    });
  }

  _createQueueTimeoutError() {
    return Object.assign(new Error("Bible request timed out while waiting for an available slot"), {
      name: "TimeoutError",
    });
  }

  _isPastDeadline(deadline) {
    return deadline !== undefined && this.nowMs() >= deadline;
  }

  _createBackoffError(remainingMs) {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const error = new Error(
      `LostArk Bible HTTP 429 - global backoff active for ${seconds}s`
    );
    error.name = "BibleRateLimitError";
    error.status = 429;
    error.retryAfterMs = remainingMs;
    error.isBibleBackoff = true;
    return error;
  }

  _openCircuit(error) {
    const requestedBackoffMs = Number(error?.retryAfterMs);
    // A Bible that is still throttling answers the first request after the
    // backoff with another 429, which reopens the circuit. The cap only bounds
    // how long one Retry-After header can block every Bible feature.
    const backoffMs = Math.min(
      requestedBackoffMs > 0 ? requestedBackoffMs : this.defaultBackoffMs,
      MAX_BIBLE_RATE_LIMIT_BACKOFF_MS
    );
    const wasBlocked = this.getBackoffRemainingMs() > 0;
    if (wasBlocked) error.isBibleBackoff = true;
    this.blockedUntil = Math.max(
      this.blockedUntil,
      this.nowMs() + backoffMs
    );

    const remainingMs = this.getBackoffRemainingMs();
    const queuedCount = this.queue.length;
    this._rejectQueued(remainingMs);
    if (!wasBlocked) {
      this.log?.warn?.(
        `[bible] HTTP 429 opened global backoff for ${Math.ceil(remainingMs / 1000)}s; rejected ${queuedCount} queued request(s).`
      );
    }
  }

  _rejectQueued(remainingMs) {
    const queued = this.queue.splice(0);
    for (const item of queued) {
      item.detach();
      item.reject(this._createBackoffError(remainingMs));
    }
  }

  _dispatch() {
    const remainingMs = this.getBackoffRemainingMs();
    if (remainingMs > 0) {
      this._rejectQueued(remainingMs);
      return;
    }

    while (this.active < this.max && this.queue.length > 0) {
      const { fn, resolve, reject, signal, deadline, detach } = this.queue.shift();
      detach();
      // Recheck the deadline before dispatch: a busy event loop can run the
      // active request's completion before an already-due timeout callback.
      if (this._isPastDeadline(deadline)) {
        reject(signal?.aborted ? signal.reason : this._createQueueTimeoutError());
        continue;
      }
      this.active += 1;
      Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          if (this._isPastDeadline(deadline)) throw this._createQueueTimeoutError();
          return fn();
        })
        .catch((error) => {
          if (isBibleRateLimitError(error)) this._openCircuit(error);
          throw error;
        })
        .finally(() => {
          this.active -= 1;
          this._dispatch();
        }).then(resolve, reject);
    }
  }
}

module.exports = {
  BIBLE_QUEUE_FULL_CODE,
  BibleRequestLimiter,
  createBibleHttpError,
  getBibleHttpStatus,
  isBibleRateLimitError,
  parseRetryAfterMs,
};
