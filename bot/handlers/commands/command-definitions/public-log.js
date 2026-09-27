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
    .setDMPermission(false)
    .addStringOption(option => option.setName("character")
      .setDescription("Character name (NA): latest public log, full tab, Bracketed ON")
      .setDescriptionLocalizations({
        vi: "Tên nhân vật (NA): log public gần nhất, full tab, Bracketed bật",
        ja: "キャラクター名 (NA): 最新の公開ログ、タブ全体、Bracketed ON",
      })
      .setRequired(true)
      .setMaxLength(64));
}

module.exports = { createRaidLogCommandDefinition };
