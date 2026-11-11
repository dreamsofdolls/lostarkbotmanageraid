"use strict";

function normalizePreviousState(claimedState, previousState = {}) {
  return Object.fromEntries(
    Object.keys(claimedState).map((field) => [field, previousState[field] ?? null])
  );
}

async function claimGuildState({
  GuildConfig,
  guildId,
  guard,
  claimedState,
}) {
  return GuildConfig.findOneAndUpdate(
    { guildId, ...guard },
    { $set: claimedState },
    // Return the exact state replaced by this claim so a failed side effect
    // can restore it without relying on the earlier (possibly stale) scan.
    { returnDocument: "before" }
  );
}

/**
 * Roll back only while every claimed field still has the value written by
 * this slot. A newer scheduler tick/config change therefore wins instead of
 * being overwritten by a late failure from an older container.
 */
async function rollbackGuildState({
  GuildConfig,
  guildId,
  claimedState,
  previousState,
}) {
  return GuildConfig.findOneAndUpdate(
    { guildId, ...claimedState },
    { $set: normalizePreviousState(claimedState, previousState) },
    { returnDocument: "after" }
  );
}

/**
 * rollbackGuildState after a failed side effect, never throwing.
 * @param {object} options - rollbackGuildState options
 * @param {(error: Error) => void} onError - reports a failed rollback
 * @returns {Promise<boolean>} true when this claim was released; false when a
 *   newer claim already replaced it or the rollback failed
 */
async function releaseGuildClaim(options, onError) {
  try {
    return Boolean(await rollbackGuildState(options));
  } catch (error) {
    onError(error);
    return false;
  }
}

/**
 * Send the post a guild claim was taken for. When no attempt posts, release
 * the claim so a later tick can try again. Logs the outcome under `label`.
 * @param {object} options - the post, its claim and its log wording
 * @param {() => Promise<unknown>} options.send - posts once; a falsy result means nothing was posted
 * @param {object} options.claim - releaseGuildClaim options: GuildConfig, guildId, claimedState, previousState
 * @param {string} options.label - log prefix, such as "[maintenance]"
 * @param {string} options.detail - what was posted, for the logs, such as "slot=T-3h key=..."
 * @param {number} [options.attempts=1] - sends tried before the claim is released
 * @param {() => Promise<void>} [options.waitBeforeRetry] - runs between attempts; a failure stops retrying
 * @returns {Promise<boolean>} true when the post went out
 */
async function sendClaimedPost({ send, claim, label, detail, attempts = 1, waitBeforeRetry }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      try {
        await waitBeforeRetry();
      } catch (err) {
        lastError = err;
        break;
      }
    }
    try {
      if (await send()) {
        console.log(`${label} posted guild=${claim.guildId} ${detail} attempt=${attempt}`);
        return true;
      }
      lastError = null;
    } catch (err) {
      lastError = err;
    }
  }

  const released = await releaseGuildClaim(claim, (rollbackError) => console.error(
    `${label} guild=${claim.guildId} ${detail} claim rollback failed:`,
    rollbackError?.message || rollbackError
  ));
  console.warn(
    `${label} send failed; claim ${released ? "released" : "not released"} guild=${claim.guildId} ${detail}:`,
    lastError?.message || lastError || "no message returned"
  );
  return false;
}

module.exports = {
  claimGuildState,
  releaseGuildClaim,
  sendClaimedPost,
};
