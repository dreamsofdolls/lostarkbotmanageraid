"use strict";

/**
 * Resolve the write target for one task command, denying view-only share
 * grants before any document is loaded.
 * @param {object} args
 * @param {string} args.executorId - Discord id running the command.
 * @param {string} args.rosterName - targeted roster name.
 * @param {string} args.commandName - command label used in share logs.
 * @param {Function} args.resolveTaskWriteTarget - shared-roster access resolver.
 * @param {Function} args.denyViewOnly - sends the view-only denial reply.
 * @param {string} [args.logKind="share-write"] - log label for share writes.
 * @param {Function} [args.logger=console.log] - log sink.
 * @returns {Promise<{ok: boolean, writeTarget: object, discordId: string}>}
 *   `ok: false` means the denial reply was already sent; stop the command.
 */
async function resolveEditableTaskWriteAccess({
  executorId,
  rosterName,
  commandName,
  resolveTaskWriteTarget,
  denyViewOnly,
  logKind = "share-write",
  logger = console.log,
}) {
  const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
  if (writeTarget.viaShare && !writeTarget.canEdit) {
    if (typeof denyViewOnly === "function") await denyViewOnly(writeTarget);
    return { ok: false, writeTarget, discordId: writeTarget.discordId };
  }

  const discordId = writeTarget.discordId;
  if (writeTarget.viaShare) {
    logger(
      `[raid-task] ${logKind} executor=${executorId} owner=${discordId} cmd=${commandName} roster=${rosterName}`,
    );
  }
  return { ok: true, writeTarget, discordId };
}

/** Recheck the original shared owner on every save attempt, without retargeting a write. */
async function revalidateTaskWriteAccess({
  access, executorId, rosterName, resolveTaskWriteTarget, denyViewOnly,
}) {
  if (access.discordId === executorId) return true;
  const current = await resolveTaskWriteTarget(executorId, rosterName);
  if (current.discordId === access.discordId && current.viaShare && current.canEdit) return true;
  // A removed grant falls back to the executor in the resolver. It must never
  // authorize the already-loaded owner's document or redirect this command.
  await denyViewOnly(access.writeTarget);
  return false;
}

module.exports = { resolveEditableTaskWriteAccess, revalidateTaskWriteAccess };
