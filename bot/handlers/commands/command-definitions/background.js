"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidBgCommandDefinition() {
  const raidBgCommand = new SlashCommandBuilder()
    .setName("raid-bg")
    .setDescription("Set / view / edit background images for your /raid-status card")
    .setDescriptionLocalizations({
      vi: "Set / xem / sửa ảnh background cho card /raid-status",
      ja: "/raid-status カードの背景画像を設定 / 表示 / 編集",
    })
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Upload 1-4 background images (overwrite or extend; library holds up to 6)")
        .setDescriptionLocalizations({
          vi: "Upload 1-4 ảnh background (ghi đè hoặc mở rộng; thư viện tối đa 6)",
          ja: "1-4枚の背景画像をアップロード（上書き or 追加; ライブラリ最大6枚）",
        })
        .addAttachmentOption((opt) =>
          opt
            .setName("image")
            .setDescription("First background image file (PNG/JPG/WEBP/SVG, 800x600+, 8MB max)")
            .setDescriptionLocalizations({
              vi: "File background đầu tiên (PNG/JPG/WEBP/SVG, 800x600+, max 8MB)",
              ja: "1枚目の背景画像ファイル（PNG/JPG/WEBP/SVG、800x600以上、最大8MB）",
            })
            .setRequired(true),
        )
        .addAttachmentOption((opt) =>
          opt
            .setName("image_2")
            .setDescription("Optional second roster background image")
            .setDescriptionLocalizations({
              vi: "Ảnh background roster thứ hai (tuỳ chọn)",
              ja: "任意の2枚目ロスター背景画像",
            })
            .setRequired(false)
        )
        .addAttachmentOption((opt) =>
          opt
            .setName("image_3")
            .setDescription("Optional third roster background image")
            .setDescriptionLocalizations({
              vi: "Ảnh background roster thứ ba (tuỳ chọn)",
              ja: "任意の3枚目ロスター背景画像",
            })
            .setRequired(false)
        )
        .addAttachmentOption((opt) =>
          opt
            .setName("image_4")
            .setDescription("Optional fourth roster background image")
            .setDescriptionLocalizations({
              vi: "Ảnh background roster thứ tư (tuỳ chọn)",
              ja: "任意の4枚目ロスター背景画像",
            })
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("How to assign uploaded images to your rosters")
            .setDescriptionLocalizations({
              vi: "Cách chia ảnh đã upload cho các roster của cậu",
              ja: "アップロード画像をロスターへ割り当てる方法",
            })
            .setRequired(false)
            .addChoices(
              { name: "Even - stable round-robin", value: "even" },
              { name: "Random - shuffle on save", value: "random" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Overwrite the whole library or extend it (default: overwrite)")
            .setDescriptionLocalizations({
              vi: "Ghi đè cả thư viện hay mở rộng (mặc định: ghi đè)",
              ja: "ライブラリ全体を上書き or 追加（既定: 上書き）",
            })
            .setRequired(false)
            .addChoices(
              {
                name: "📥 Overwrite",
                value: "overwrite",
                name_localizations: { vi: "📥 Ghi đè", ja: "📥 上書き" },
              },
              {
                name: "➕ Extend",
                value: "extend",
                name_localizations: { vi: "➕ Mở rộng", ja: "➕ 追加" },
              }
            )
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("Preview your current background")
        .setDescriptionLocalizations({
          vi: "Xem background hiện tại của cậu",
          ja: "現在の背景を確認",
        }),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit your library: replace a scene (attach an image) or delete scenes")
        .setDescriptionLocalizations({
          vi: "Sửa thư viện: thay 1 cảnh (kèm ảnh) hoặc xoá cảnh",
          ja: "ライブラリを編集: シーンを差し替え（画像添付）または削除",
        })
        .addAttachmentOption((opt) =>
          opt
            .setName("image")
            .setDescription("New image to replace a scene with (omit to delete scenes instead)")
            .setDescriptionLocalizations({
              vi: "Ảnh mới để thay vào 1 cảnh (bỏ trống để chuyển sang chế độ xoá)",
              ja: "シーンを差し替える新しい画像（省略すると削除モード）",
            })
            .setRequired(false)
        ),
    );

  return raidBgCommand;
}

module.exports = {
  createRaidBgCommandDefinition,
};
