"use strict";

/**
 * Wrap an async collector listener so a rejection is logged, not left
 * unhandled. Collectors emit without captureRejections, so a failed Discord
 * call (10062 Unknown interaction, for one) would otherwise reach
 * process-lifecycle, which exits the bot on any unhandled rejection.
 */
function guardCollectorListener(logTag, listener) {
  return async (...args) => {
    try {
      await listener(...args);
    } catch (err) {
      const customId = args[0]?.customId;
      console.error(`${logTag}${customId ? ` ${customId}` : ""} failed:`, err);
    }
  };
}

module.exports = {
  guardCollectorListener,
};
