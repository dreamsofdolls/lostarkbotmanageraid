"use strict";

const { SlashCommandBuilder } = require("discord.js");

function createRaidLogCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("raid-log")
    .setDescription("(TEST) Browse public raid logs with MVPs, scores and every Bible tab")
    .setDescriptionLocalizations({
      vi: "(TEST) Xem log public: MVP, score và mọi tab Bible",
      ja: "(TEST) 公開ログを閲覧: MVP、スコア、Bible の全タブ",
    })
    .setDMPermission(false);
}

module.exports = { createRaidLogCommandDefinition };
