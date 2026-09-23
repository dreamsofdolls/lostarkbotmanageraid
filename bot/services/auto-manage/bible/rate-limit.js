"use strict";

const DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

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

function createBibleHttpError(message, response, nowMs = Date.now()) {
  const error = new Error(message);
  error.status = Number(response?.status) || null;
  const retryAfterMs = getRetryAfterMs(response, nowMs);
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

function isBibleRateLimitError(error) {
  return Number(error?.status) === 429 ||
    /\bHTTP 429\b|rate.?limit/i.test(error?.message || String(error || ""));
}

class BibleRequestLimiter {
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

  getBackoffRemainingMs() {
    return Math.max(0, this.blockedUntil - this.nowMs());
  }

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
    const backoffMs = requestedBackoffMs > 0
      ? requestedBackoffMs
      : this.defaultBackoffMs;
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
  DEFAULT_BIBLE_RATE_LIMIT_BACKOFF_MS,
  createBibleHttpError,
  getRetryAfterMs,
  isBibleRateLimitError,
  parseRetryAfterMs,
};
