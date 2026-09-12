"use strict";

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
