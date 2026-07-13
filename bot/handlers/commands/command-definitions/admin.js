"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidChannelCommandDefinition() {
  const raidChannelCommand = new SlashCommandBuilder()
    .setName("raid-channel")
    .setDescription("Configure the raid monitor channel")
    .setDescriptionLocalizations({
      vi: "Cấu hình kênh raid monitor",
      ja: "レイドモニターチャンネルを設定",
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Config action to run")
        .setDescriptionLocalizations({
          vi: "Hành động cấu hình cần chạy",
          ja: "実行する設定アクション",
        })
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Which action to run")
            .setDescriptionLocalizations({
              vi: "Chọn action để chạy",
              ja: "実行するアクションを選択",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Target text channel (for action=set)")
            .setDescriptionLocalizations({
              vi: "Text channel đích (cho action=set)",
              ja: "対象テキストチャンネル（action=set 用）",
            })
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption((opt) =>
          opt
            .setName("language")
            .setDescription("Broadcast language (for action=set-language)")
            .setDescriptionLocalizations({
              vi: "Ngôn ngữ broadcast (cho action=set-language)",
              ja: "配信言語（action=set-language 用）",
            })
            .setRequired(false)
            .addChoices(
              { name: "🇻🇳 Tiếng Việt", value: "vi" },
              { name: "🇯🇵 日本語", value: "jp" },
              { name: "🇬🇧 English", value: "en" },
            )
        )
    );

  return raidChannelCommand;
}

function createRaidAutoManageCommandDefinition() {
  const raidAutoManageCommand = new SlashCommandBuilder()
    .setName("raid-auto-manage")
    .setDescription("Auto-sync raid progress from lostark.bible")
    .setDescriptionLocalizations({
      vi: "Tự động đồng bộ tiến độ raid từ lostark.bible",
      ja: "lostark.bible からレイド進捗を自動同期",
    })
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("on · off · sync · status · local-on · local-off · reset")
        .setDescriptionLocalizations({
          vi: "on · off · sync · status · local-on · local-off · reset",
          ja: "on · off · sync · status · local-on · local-off · reset",
        })
        .setRequired(true)
        // Autocomplete, rather than static choices, hides redundant and
        // mutex-blocked actions from the dropdown. Six actions total
        // (bible on/off/sync, local on/off, status); filter logic lives
        // in handleRaidAutoManageAutocomplete and reads both flags.
        .setAutocomplete(true)
    );

  return raidAutoManageCommand;
}

function createRaidAnnounceCommandDefinition({ announcementTypeKeys, announcementTypeEntry }) {
  const raidAnnounceCommand = new SlashCommandBuilder()
    .setName("raid-announce")
    .setDescription("[Admin] Configure Artist's channel announcements")
    .setDescriptionLocalizations({
      vi: "[Admin] Cấu hình thông báo kênh của Artist",
      ja: "[Admin] Artist のチャンネルアナウンスを設定",
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Announcement type")
        .setDescriptionLocalizations({
          vi: "Loại announcement",
          ja: "アナウンスの種類",
        })
        .setRequired(true)
        .addChoices(
          // Display the clean English label only - key is the `value` under
          // the hood so user-facing text isn't a dash soup (key-slug + dash
          // separator + label). Derived from ANNOUNCEMENT_REGISTRY.
          ...announcementTypeKeys().map((key) => ({
            name: announcementTypeEntry(key).label,
            value: key,
          }))
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("What to do with the selected announcement")
        .setDescriptionLocalizations({
          vi: "Làm gì với announcement đã chọn",
          ja: "選択したアナウンスへの操作",
        })
        .setRequired(true)
        // Autocomplete (not static choices) so labels can annotate the
        // CURRENT per-guild state (e.g. "Turn on (currently OFF)") and hide
        // redundant actions (on while on, off while off, clear-channel when
        // no override set, set-channel for channel-bound types).
        .setAutocomplete(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Destination channel (required when action = Set channel override)")
        .setDescriptionLocalizations({
          vi: "Kênh đích (bắt buộc khi action = Set channel override)",
          ja: "配信先チャンネル（action = Set channel override の場合は必須）",
        })
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)
    );

  return raidAnnounceCommand;
}

module.exports = {
  createRaidChannelCommandDefinition,
  createRaidAutoManageCommandDefinition,
  createRaidAnnounceCommandDefinition,
};
