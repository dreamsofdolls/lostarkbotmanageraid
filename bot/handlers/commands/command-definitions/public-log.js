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
      .setDescription("Character name (NA): capture their latest public log; use this or url")
      .setDescriptionLocalizations({
        vi: "Tên nhân vật (NA): lấy log public gần nhất; chọn character hoặc url",
        ja: "キャラクター名 (NA): 最新の公開ログ。character または url を指定",
      })
      .setMaxLength(64))
    .addStringOption(option => option.setName("url")
      .setDescription("Public log URL: https://lostark.bible/logs/...")
      .setDescriptionLocalizations({ vi: "Link log public: https://lostark.bible/logs/...", ja: "公開ログの URL" })
      .setMaxLength(200))
    .addStringOption(option => option.setName("view")
      .setDescription("Image area (default: team Damage tables)")
      .setDescriptionLocalizations({ vi: "Phần cần chụp (mặc định: bảng DMG của team)", ja: "撮影範囲 (既定: チームの DMG 表)" })
      .addChoices(
        { name: "Team Damage", value: "team", name_localizations: { vi: "Bảng DMG của team", ja: "チームの DMG 表" } },
        { name: "Full Damage tab", value: "full", name_localizations: { vi: "Tab Damage đầy đủ", ja: "Damage タブ全体" } },
      ));
}

module.exports = { createRaidLogCommandDefinition };
