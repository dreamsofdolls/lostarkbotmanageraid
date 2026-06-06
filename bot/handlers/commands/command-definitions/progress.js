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

function createRaidProfileCommandDefinition() {
  const raidProfileCommand = new SlashCommandBuilder()
    .setName("raid-profile")
    .setDescription("View combat profile stats from local LOA Logs")
    .setDescriptionLocalizations({
      vi: "Xem bảng chỉ số combat từ LOA Logs local",
      ja: "LOA Logs ローカルから戦闘プロフィール統計を表示",
    })
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("view (default) · reset (wipe your own profile to re-sync)")
        .setDescriptionLocalizations({
          vi: "view (mặc định) · reset (xoá hồ sơ của chính cậu để sync lại)",
          ja: "view (既定) · reset (自分のプロフィールを消去して再同期)",
        })
        .setRequired(false)
        .addChoices(
          {
            name: "📊 View profile",
            name_localizations: { vi: "📊 Xem hồ sơ", ja: "📊 プロフィール表示" },
            value: "view",
          },
          {
            name: "🧹 Reset my profile",
            name_localizations: { vi: "🧹 Reset hồ sơ của tôi", ja: "🧹 自分のプロフィールをリセット" },
            value: "reset",
          }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("visibility")
        .setDescription("hide (default, only you) · show (visible to the channel)")
        .setDescriptionLocalizations({
          vi: "ẩn (mặc định, chỉ mình cậu) · hiện (cả channel thấy)",
          ja: "非表示 (既定、自分のみ) · 表示 (チャンネルに公開)",
        })
        .setRequired(false)
        .addChoices(
          {
            name: "🔒 Hide (only me)",
            name_localizations: { vi: "🔒 Ẩn (chỉ mình tôi)", ja: "🔒 非表示 (自分のみ)" },
            value: "hide",
          },
          {
            name: "👁 Show (visible to channel)",
            name_localizations: { vi: "👁 Hiện (cả channel thấy)", ja: "👁 表示 (チャンネルに公開)" },
            value: "show",
          }
        )
    );

  return raidProfileCommand;
}

module.exports = {
  createRaidCheckCommandDefinition,
  createRaidSetCommandDefinition,
  createStatusCommandDefinition,
  createRaidProfileCommandDefinition,
};
