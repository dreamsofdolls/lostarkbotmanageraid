"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidHelpCommandDefinition() {
  const raidHelpCommand = new SlashCommandBuilder()
    .setName("raid-help")
    .setDescription("Show help for all raid commands")
    .setDescriptionLocalizations({
      vi: "Hiện trợ giúp cho tất cả lệnh raid",
      ja: "すべてのレイドコマンドのヘルプを表示",
    })
    .addStringOption((option) =>
      option
        .setName("language")
        .setDescription("Display language (default: your /raid-language preference)")
        .setDescriptionLocalizations({
          vi: "Ngôn ngữ hiển thị (mặc định: theo /raid-language của cậu)",
          ja: "表示言語（既定: /raid-language の設定）",
        })
        .setRequired(false)
        .addChoices(
          { name: "Tiếng Việt", value: "vi" },
          { name: "English", value: "en" },
          { name: "日本語", value: "jp" }
        )
    );

  return raidHelpCommand;
}

function createRaidLanguageCommandDefinition() {
  const raidLanguageCommand = new SlashCommandBuilder()
    .setName("raid-language")
    .setDescription("Đổi ngôn ngữ Artist hiển thị cho cậu (Tiếng Việt / 日本語)")
    .setDescriptionLocalizations({
      vi: "Đổi ngôn ngữ Artist hiển thị cho cậu (Tiếng Việt / 日本語)",
      ja: "Artist の表示言語を切り替え（Tiếng Việt / 日本語）",
    })
    .setDMPermission(false);

  return raidLanguageCommand;
}

function createRaidShareCommandDefinition() {
  const raidShareCommand = new SlashCommandBuilder()
    .setName("raid-share")
    .setDescription("Manager: share roster access with another user")
    .setDescriptionLocalizations({
      vi: "Manager: chia sẻ quyền truy cập roster với user khác",
      ja: "Manager: 他ユーザーにロスターへのアクセスを共有",
    })
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("grant")
        .setDescription("Share all your rosters with another user (Manager-only)")
        .setDescriptionLocalizations({
          vi: "Chia sẻ tất cả roster của cậu cho user khác (chỉ Manager)",
          ja: "自分の全ロスターを他ユーザーに共有（Manager 限定）",
        })
        .addUserOption((opt) =>
          opt
            .setName("target")
            .setDescription("User to receive share access")
            .setDescriptionLocalizations({
              vi: "User nhận quyền chia sẻ",
              ja: "共有アクセスを受け取るユーザー",
            })
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("permission")
            .setDescription("Access level (default: edit)")
            .setDescriptionLocalizations({
              vi: "Mức truy cập (mặc định: edit)",
              ja: "アクセス権限（既定: edit）",
            })
            .setRequired(false)
            .addChoices(
              {
                name: "edit (read + write)",
                name_localizations: {
                  vi: "edit (xem + chỉnh sửa)",
                  ja: "編集可 (閲覧 + 更新)",
                },
                value: "edit",
              },
              {
                name: "view (read-only)",
                name_localizations: {
                  vi: "view (chỉ xem)",
                  ja: "閲覧のみ",
                },
                value: "view",
              }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("Revoke a previously granted share (Manager-only)")
        .setDescriptionLocalizations({
          vi: "Thu hồi share đã cấp trước đó (chỉ Manager)",
          ja: "以前付与した共有を取り消し（Manager 限定）",
        })
        .addUserOption((opt) =>
          opt
            .setName("target")
            .setDescription("User whose share access should be revoked")
            .setDescriptionLocalizations({
              vi: "User cần thu hồi quyền chia sẻ",
              ja: "共有アクセスを取り消すユーザー",
            })
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List shares: outgoing (you grant), incoming (you receive), or both")
        .setDescriptionLocalizations({
          vi: "Liệt kê share: outgoing (cậu cấp), incoming (cậu nhận), hoặc cả hai",
          ja: "共有一覧: outgoing（自分が付与）/ incoming（自分が受領）/ 両方",
        })
        .addStringOption((opt) =>
          opt
            .setName("direction")
            .setDescription("Which direction to show (default: both)")
            .setDescriptionLocalizations({
              vi: "Hướng nào cần xem (mặc định: cả hai)",
              ja: "表示する方向（既定: 両方）",
            })
            .setRequired(false)
            .addChoices(
              {
                name: "both",
                name_localizations: { vi: "cả hai", ja: "両方" },
                value: "both",
              },
              {
                name: "out (shares you granted)",
                name_localizations: {
                  vi: "out (cậu đã share cho người khác)",
                  ja: "out (あなたが渡した分)",
                },
                value: "out",
              },
              {
                name: "in (shares you received)",
                name_localizations: {
                  vi: "in (người khác share cho cậu)",
                  ja: "in (あなたが受け取った分)",
                },
                value: "in",
              }
            )
        )
    );

  return raidShareCommand;
}

function createRaidAuctionCommandDefinition() {
  const raidAuctionCommand = new SlashCommandBuilder()
    .setName("raid-auction")
    .setDescription("Calculate auction bids for 4 and 8 player parties from one market value")
    .setDescriptionLocalizations({
      vi: "Tính giá bid đấu giá cho cả party 4 và 8 người từ một giá trị thị trường",
      ja: "市場価格1つから4人・8人パーティの入札額をまとめて計算",
    })
    .addIntegerOption((option) =>
      option
        .setName("market_value")
        .setDescription("Market value of the item (the AH listing price; 5% sell fee is auto-deducted)")
        .setDescriptionLocalizations({
          vi: "Giá thị trường của vật phẩm (giá listing trên AH; phí bán 5% tự trừ)",
          ja: "アイテムの市場価格（AHの掲載価格；売却手数料5%は自動控除）",
        })
        .setRequired(true)
        .setMinValue(1)
    )
    .addBooleanOption((option) =>
      option
        .setName("profit")
        .setDescription("Apply 8% profit margin (default: on)")
        .setDescriptionLocalizations({
          vi: "Áp dụng biên lợi nhuận 8% (mặc định: bật)",
          ja: "8%の利益マージンを適用（デフォルト: オン）",
        })
        .setRequired(false)
    );

  return raidAuctionCommand;
}

module.exports = {
  createRaidHelpCommandDefinition,
  createRaidLanguageCommandDefinition,
  createRaidShareCommandDefinition,
  createRaidAuctionCommandDefinition,
};
