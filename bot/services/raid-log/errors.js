"use strict";

const { BIBLE_ERROR_KIND, classifyBibleError } = require("../auto-manage/bible/error-kinds");

const BIBLE_ERROR_CODES = new Map([
  [BIBLE_ERROR_KIND.notFound, "character_not_found"],
  [BIBLE_ERROR_KIND.publicLogOff, "logs_private"],
  [BIBLE_ERROR_KIND.rateLimit, "rate_limited"],
  [BIBLE_ERROR_KIND.blocked, "unavailable"],
]);

class RaidLogError extends Error {
  constructor(code, cause) {
    super(`Raid log: ${code}`, { cause });
    this.code = code;
  }
}

function raidLogErrorCode(error) {
  if (error instanceof RaidLogError) return error.code;
  if (error?.code === "BIBLE_QUEUE_FULL") return "busy";
  if (["TimeoutError", "AbortError"].includes(error?.name)) return "timeout";
  return BIBLE_ERROR_CODES.get(classifyBibleError(error)) || "failed";
}

module.exports = { RaidLogError, raidLogErrorCode };
