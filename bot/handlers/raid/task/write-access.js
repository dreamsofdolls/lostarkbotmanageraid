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

module.exports = { resolveEditableTaskWriteAccess };
