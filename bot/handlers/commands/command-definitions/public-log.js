"use strict";

const { SlashCommandBuilder } = require("discord.js");

function createRaidLogCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("raid-log")
    .setDescription("(TEST) Browse public raid logs, switch tabs and toggle Bracketed")
    .setDescriptionLocalizations({
      vi: "(TEST) Xem log public, chọn raid / tab và bật tắt Bracketed",
      ja: "(TEST) 公開ログを閲覧、レイド・タブ・Bracketed を切り替え",
    })
    .setDMPermission(false);
}

module.exports = { createRaidLogCommandDefinition };
