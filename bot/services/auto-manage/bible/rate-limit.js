"use strict";

const DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const MAX_BIBLE_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

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

/**
 * @param {unknown} error - an Error or an error message
 * @returns {boolean} true for an HTTP 429 status or a rate-limit message
 */
function isBibleRateLimitError(error) {
  return Number(error?.status) === 429 ||
    /\bHTTP 429\b|rate.?limit/i.test(error?.message || String(error || ""));
}

/**
 * Caps concurrent Bible requests. After an HTTP 429 it rejects every queued
 * and new request with a backoff error until the backoff ends.
 */
class BibleRequestLimiter {
  /**
   * @param {number} max - requests allowed in flight at once
   * @param {{defaultBackoffMs?: number, nowMs?: () => number, log?: Console}} [options]
   *   `defaultBackoffMs` applies when a 429 carries no Retry-After
   */
  constructor(
    max,
    {
      defaultBackoffMs = DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS,
      nowMs = () => Date.now(),
      log = console,
    } = {}
  ) {
    this.max = Math.max(1, Number(max) || 1);
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
   * @returns {Promise<T>} its result, or a backoff error while the backoff is active
   */
  run(fn) {
    const remainingMs = this.getBackoffRemainingMs();
    if (remainingMs > 0) {
      return Promise.reject(this._createBackoffError(remainingMs));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._dispatch();
    });
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
      const { fn, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, (error) => {
          if (isBibleRateLimitError(error)) this._openCircuit(error);
          reject(error);
        })
        .finally(() => {
          this.active -= 1;
          this._dispatch();
        });
    }
  }
}

module.exports = {
  BibleRequestLimiter,
  createBibleHttpError,
  isBibleRateLimitError,
  parseRetryAfterMs,
};
