"use strict";

function createAddRosterTargetResolver({
  isManagerId,
  t,
  replyNotice,
}) {
  async function resolveAddRosterTarget({ interaction, callerId, lang }) {
    const targetUser = interaction.options.getUser("target");
    if (!targetUser || targetUser.id === callerId) {
      return {
        handled: false,
        discordId: callerId,
        targetUser: targetUser || null,
        actingForOther: false,
      };
    }

    if (typeof isManagerId !== "function" || !isManagerId(callerId)) {
      await replyNotice(interaction, {
        type: "lock",
        title: t("raid-add-roster.auth.managerOnlyTitle", lang),
        description: t("raid-add-roster.auth.managerOnlyDescription", lang),
      });
      return { handled: true };
    }

    if (targetUser.bot) {
      await replyNotice(interaction, {
        type: "warn",
        title: t("raid-add-roster.auth.botTargetTitle", lang),
        description: t("raid-add-roster.auth.botTargetDescription", lang),
      });
      return { handled: true };
    }

    return {
      handled: false,
      discordId: targetUser.id,
      targetUser,
      actingForOther: true,
    };
  }

  return { resolveAddRosterTarget };
}

module.exports = { createAddRosterTargetResolver };
