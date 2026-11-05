"use strict";

const { NoticeKind, buildManagerOnlyField } = require("../../../utils/raid/common/shared");

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

    if (!isManagerId(callerId)) {
      await replyNotice(interaction, {
        kind: NoticeKind.GUARD,
        title: t("raid-add-roster.auth.managerOnlyTitle", lang),
        description: t("raid-add-roster.auth.managerOnlyDescription", lang),
        fields: [buildManagerOnlyField(lang)],
        tip: t("raid-add-roster.auth.managerOnlyTip", lang),
      });
      return { handled: true };
    }

    if (targetUser.bot) {
      await replyNotice(interaction, {
        kind: NoticeKind.INPUT,
        title: t("raid-add-roster.auth.botTargetTitle", lang),
        description: t("raid-add-roster.auth.botTargetDescription", lang),
        tip: t("raid-add-roster.auth.botTargetTip", lang),
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
