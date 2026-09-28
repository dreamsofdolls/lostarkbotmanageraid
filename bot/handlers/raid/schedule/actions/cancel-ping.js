"use strict";

const { t } = require("../../../../services/i18n");
const { sendToBoardChannel } = require("../../../../services/raid/schedule/board-io");

function signupDiscordIds(event) {
  return [...new Set((event.signups || []).map((signup) => signup.discordId))];
}

/**
 * Tag the signups of a cancelled or deleted board in its channel. Skipped
 * when nobody signed up or the lead turned notifications off.
 * @param {object} client - discord.js client
 * @param {object} event - the RaidEvent
 * @param {string} lang - the board's language
 * @param {string[]} ids - signup Discord IDs
 * @param {string} logLabel - log label when the post fails
 */
async function pingCancelledSignups(client, event, lang, ids, logLabel) {
  if (ids.length === 0 || event.skipNotify) return;
  await sendToBoardChannel(client, event.channelId, {
    content: t("raid-schedule.notice.cancelPingContent", lang, {
      users: ids.map((id) => `<@${id}>`).join(" "),
      title: event.title || "",
    }),
  }, { logLabel });
}

module.exports = {
  signupDiscordIds,
  pingCancelledSignups,
};
