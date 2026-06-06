"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createAddRosterCommandDefinition() {
  const addRosterCommand = new SlashCommandBuilder()
    .setName("raid-add-roster")
    .setDescription("Sync a roster from lostark.bible")
    .setDescriptionLocalizations({
      vi: "Đồng bộ roster từ lostark.bible",
      ja: "lostark.bible からロスターを同期",
    })
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Any character name in the roster")
        .setDescriptionLocalizations({
          vi: "Tên một character bất kỳ trong roster",
          ja: "ロスター内の任意のキャラクター名",
        })
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("(Raid Manager only) Add roster on behalf of another user")
        .setDescriptionLocalizations({
          vi: "(Raid Manager) Add roster giúp user khác",
          ja: "(Raid Manager 限定) 他ユーザーのロスターを代理登録",
        })
        .setRequired(false)
    );

  // /raid-check has no command-line options. Cross-raid overview is the
  // sole entry point; per-raid focus is achieved via the inline raid-
  // filter dropdown inside the embed. The previous `raid` option (with
  // its 7+1 choice list) was retired in round-32 because the inline
  // filter offered the same UX without doubling the command surface.

  return addRosterCommand;
}

function createEditRosterCommandDefinition() {
  const editRosterCommand = new SlashCommandBuilder()
    .setName("raid-edit-roster")
    .setDescription("Edit an existing roster: add chars from bible or remove saved chars")
    .setDescriptionLocalizations({
      vi: "Sửa roster đã lưu: thêm char từ bible hoặc xóa char đã lưu",
      ja: "既存ロスターを編集: bible からキャラ追加 / 保存済みキャラ削除",
    })
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Which saved roster to edit (autocomplete)")
        .setDescriptionLocalizations({
          vi: "Roster nào cần sửa (autocomplete)",
          ja: "編集する保存済みロスター（オートコンプリート）",
        })
        .setRequired(true)
        .setAutocomplete(true)
    );

  return editRosterCommand;
}

function createRaidGoldEarnerCommandDefinition() {
  const raidGoldEarnerCommand = new SlashCommandBuilder()
    .setName("raid-gold-earner")
    .setDescription("Pick which characters in a roster earn weekly gold (LA cap 6/account)")
    .setDescriptionLocalizations({
      vi: "Chọn char nào trong roster ăn gold weekly (LA cap 6/account)",
      ja: "ロスター内で週間ゴールドを得るキャラを選択（LA上限 6/アカウント）",
    })
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Roster (account) to configure - autocomplete")
        .setDescriptionLocalizations({
          vi: "Roster (account) cần cấu hình - autocomplete",
          ja: "設定するロスター（アカウント）- オートコンプリート",
        })
        .setRequired(true)
        .setAutocomplete(true)
    );

  return raidGoldEarnerCommand;
}

function createRemoveRosterCommandDefinition() {
  const removeRosterCommand = new SlashCommandBuilder()
    .setName("raid-remove-roster")
    .setDescription("Remove a roster or a character")
    .setDescriptionLocalizations({
      vi: "Xóa một roster hoặc một character",
      ja: "ロスターまたはキャラクターを削除",
    })
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Roster to target")
        .setDescriptionLocalizations({
          vi: "Roster cần thao tác",
          ja: "対象のロスター",
        })
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("What to remove")
        .setDescriptionLocalizations({
          vi: "Cần xóa cái gì",
          ja: "削除する対象",
        })
        .setRequired(true)
        .addChoices(
          {
            name: "Remove entire roster",
            name_localizations: {
              vi: "Xoá cả roster",
              ja: "ロスター全体を削除",
            },
            value: "remove_roster",
          },
          {
            name: "Remove a single character",
            name_localizations: {
              vi: "Xoá 1 character",
              ja: "キャラ 1 体を削除",
            },
            value: "remove_char",
          }
        )
    )
    .addStringOption((option) =>
      option
        .setName("character")
        .setDescription("Character to remove (if removing one char)")
        .setDescriptionLocalizations({
          vi: "Character cần xóa (nếu xóa từng char)",
          ja: "削除するキャラクター（単体削除の場合）",
        })
        .setRequired(false)
        .setAutocomplete(true)
    );

  return removeRosterCommand;
}

module.exports = {
  createAddRosterCommandDefinition,
  createEditRosterCommandDefinition,
  createRaidGoldEarnerCommandDefinition,
  createRemoveRosterCommandDefinition,
};
