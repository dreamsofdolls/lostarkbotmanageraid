"use strict";

async function tryEnableAutoManage(UserModel, discordId) {
  if (!discordId) return { outcome: "missing" };
  let updated;
  try {
    updated = await UserModel.findOneAndUpdate(
      { discordId, autoManageEnabled: { $ne: true }, localSyncEnabled: { $ne: true } },
      { $set: { autoManageEnabled: true } },
      { new: true }
    );
  } catch (err) {
    return { outcome: "error", error: err };
  }

  if (updated) return { outcome: "flipped", doc: updated };

  let existing;
  try {
    existing = await UserModel.findOne({ discordId })
      .select("_id autoManageEnabled localSyncEnabled")
      .lean();
  } catch {
    existing = null;
  }
  if (!existing) return { outcome: "missing" };
  if (existing.localSyncEnabled) return { outcome: "local-locked" };
  return { outcome: "already-on" };
}

async function tryDisableAutoManage(UserModel, discordId) {
  if (!discordId) return { outcome: "missing" };
  let updated;
  try {
    updated = await UserModel.findOneAndUpdate(
      { discordId, autoManageEnabled: true },
      {
        $set: {
          autoManageEnabled: false,
          lastLocalSyncToken: null,
          lastLocalSyncTokenExpAt: null,
        },
      },
      { new: true }
    );
  } catch (err) {
    return { outcome: "error", error: err };
  }

  if (updated) return { outcome: "disabled", doc: updated };

  let existing;
  try {
    existing = await UserModel.findOne({ discordId })
      .select("_id autoManageEnabled")
      .lean();
  } catch {
    existing = null;
  }
  if (!existing) return { outcome: "missing" };
  return { outcome: "already-off" };
}

module.exports = {
  tryDisableAutoManage,
  tryEnableAutoManage,
};
