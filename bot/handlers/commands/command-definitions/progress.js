"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidCheckCommandDefinition() {
  const raidCheckCommand = new SlashCommandBuilder()
    .setName("raid-check")
    .setDescription("(Raid Leader) Cross-raid overview of guild progress")
    .setDescriptionLocalizations({
      vi: "(Raid Leader) Tổng quan tiến độ raid của cả guild",
      ja: "(Raid Leader) ギルド全体のレイド進捗一覧",
    });

  return raidCheckCommand;
}

function createRaidSetCommandDefinition() {
  const raidSetCommand = new SlashCommandBuilder()
    .setName("raid-set")
    .setDescription("Mark raid progress for a character")
    .setDescriptionLocalizations({
      vi: "Đánh dấu tiến độ raid cho character",
      ja: "キャラのレイド進捗を更新",
    })
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Roster (account) chứa character - autocomplete")
        .setDescriptionLocalizations({
          vi: "Roster (account) chứa character - autocomplete",
          ja: "キャラを含むロスター（アカウント）- オートコンプリート",
        })
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("character")
        .setDescription("Character to update")
        .setDescriptionLocalizations({
          vi: "Character cần cập nhật",
          ja: "更新するキャラクター",
        })
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("raid")
        .setDescription("Raid to update for this character")
        .setDescriptionLocalizations({
          vi: "Raid cần cập nhật cho character này",
          ja: "このキャラで更新するレイド",
        })
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("status")
        .setDescription("complete | process | reset (process marks one gate)")
        .setDescriptionLocalizations({
          vi: "complete | process | reset (process đánh dấu một gate)",
          ja: "complete | process | reset（process は1ゲートのみ更新）",
        })
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("gate")
        .setDescription("Specific gate (required when status=process)")
        .setDescriptionLocalizations({
          vi: "Gate cụ thể (bắt buộc khi status=process)",
          ja: "特定のゲート（status=process の場合は必須）",
        })
        .setRequired(false)
        .setAutocomplete(true)
    );

  return raidSetCommand;
}

function createStatusCommandDefinition() {
  const statusCommand = new SlashCommandBuilder()
    .setName("raid-status")
    .setDescription("View your raid progress")
    .setDescriptionLocalizations({
      vi: "Xem tiến độ raid của cậu",
      ja: "あなたのレイド進捗を表示",
    });

  return statusCommand;
}

module.exports = {
  createRaidCheckCommandDefinition,
  createRaidSetCommandDefinition,
  createStatusCommandDefinition,
};
