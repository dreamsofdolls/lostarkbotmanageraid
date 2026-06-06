"use strict";

function createTargetDmDelivery({
  User,
  getUserLanguage,
  buildTargetDMEmbed,
  logger = console,
}) {
  async function tryDeliverTargetDM(client, session, savedAccount, guildName) {
    if (!session.actingForOther || !session.targetId) {
      return { delivered: false, reason: "not-acting-for-other" };
    }
    try {
      const targetLang = await getUserLanguage(session.targetId, { UserModel: User });
      const targetUser = await client.users.fetch(session.targetId);
      await targetUser.send({
        embeds: [buildTargetDMEmbed(session, savedAccount, guildName, targetLang)],
      });
      return { delivered: true };
    } catch (err) {
      const dmsDisabled = err?.code === 50007 || err?.rawError?.code === 50007;
      logger.warn?.(
        `[add-roster] DM to target ${session.targetId} failed${dmsDisabled ? " (DMs disabled)" : ""}: ${err?.message || err}`
      );
      return {
        delivered: false,
        reason: dmsDisabled ? "dms-disabled" : "error",
      };
    }
  }

  return { tryDeliverTargetDM };
}

module.exports = {
  createTargetDmDelivery,
};
