"use strict";

const MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER = 8;

const subscribersByDiscordId = new Map();

function normalizeDiscordIds(discordIds) {
  const values = Array.isArray(discordIds) ? discordIds : [discordIds];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function reportListenerError(error, event, onError) {
  if (typeof onError !== "function") return;
  try {
    onError(error, event);
  } catch {
    // A logging failure must not escape into the Reader request.
  }
}

/**
 * Subscribe an active Discord view to confirmed Local Reader applies.
 * Listener sets are capped per owner and removed when the returned cleanup runs.
 * @param {string|string[]} discordIds - Roster owners visible in the active view.
 * @param {(event: object) => unknown} listener - Fast callback that schedules view work.
 * @param {object} [options]
 * @param {(error: unknown, event: object) => void} [options.onError]
 * @returns {() => void} Idempotent cleanup function.
 */
function subscribeLocalSyncApplied(discordIds, listener, { onError = null } = {}) {
  if (typeof listener !== "function") {
    throw new TypeError("subscribeLocalSyncApplied requires a listener");
  }

  const ids = normalizeDiscordIds(discordIds);
  const wrapped = (event) => {
    try {
      const result = listener(event);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch((error) => reportListenerError(error, event, onError));
      }
    } catch (error) {
      reportListenerError(error, event, onError);
    }
  };

  for (const discordId of ids) {
    let listeners = subscribersByDiscordId.get(discordId);
    if (!listeners) {
      listeners = new Set();
      subscribersByDiscordId.set(discordId, listeners);
    }
    if (listeners.size >= MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER) {
      listeners.delete(listeners.values().next().value);
    }
    listeners.add(wrapped);
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const discordId of ids) {
      const listeners = subscribersByDiscordId.get(discordId);
      if (!listeners) continue;
      listeners.delete(wrapped);
      if (listeners.size === 0) subscribersByDiscordId.delete(discordId);
    }
  };
}

/**
 * Notify active views that one owner's preview reached persisted applied state.
 * Callbacks are invoked synchronously only far enough to schedule their async work.
 * @param {object} event
 * @param {string} event.discordId - Preview owner whose roster changed.
 * @param {string} [event.jobId] - Applied preview identity.
 * @returns {number} Number of active listeners notified.
 */
function publishLocalSyncApplied(event) {
  const discordId = String(event?.discordId || "").trim();
  if (!discordId) return 0;
  const listeners = subscribersByDiscordId.get(discordId);
  if (!listeners || listeners.size === 0) return 0;

  const normalizedEvent = Object.freeze({
    discordId,
    jobId: String(event?.jobId || "").trim(),
  });
  const snapshot = [...listeners];
  for (const listener of snapshot) listener(normalizedEvent);
  return snapshot.length;
}

module.exports = {
  MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER,
  publishLocalSyncApplied,
  subscribeLocalSyncApplied,
};
