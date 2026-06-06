"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");
const { RAID_REQUIREMENTS } = require("../../../domain/raid-catalog");

const RAID_SCHEDULE_RAID_CHOICES = Object.entries(RAID_REQUIREMENTS).map(
  ([key, raid]) => ({ name: raid.label, value: key })
);
const RAID_SCHEDULE_MODE_CHOICES = [
  { name: "Normal", value: "normal" },
  { name: "Hard", value: "hard" },
  { name: "Nightmare", value: "nightmare" },
];

function createRaidScheduleCommandDefinition() {
  const raidScheduleCommand = new SlashCommandBuilder()
    .setName("raid-schedule-preview")
    .setDescription("(Raid Manager, preview) Create and manage raid signup boards")
    .setDescriptionLocalizations({
      vi: "(Raid Manager, preview) Tạo và quản lý bảng đăng ký raid",
      ja: "(Raid Manager, preview) レイド募集ボードを作成・管理",
    })
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a raid signup board")
        .setDescriptionLocalizations({
          vi: "Tạo bảng đăng ký raid",
          ja: "レイド募集ボードを作成",
        })
        .addStringOption((option) =>
          option
            .setName("raid")
            .setDescription("Raid")
            .setDescriptionLocalizations({ vi: "Raid", ja: "レイド" })
            .setRequired(true)
            .addChoices(...RAID_SCHEDULE_RAID_CHOICES)
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Difficulty")
            .setDescriptionLocalizations({ vi: "Độ khó", ja: "難易度" })
            .setRequired(true)
            .addChoices(...RAID_SCHEDULE_MODE_CHOICES)
        )
        .addStringOption((option) =>
          option
            .setName("when")
            .setDescription("Start: 20:00, 8pm, +2h, 'wed 20:00', 'thứ 4 20:00', '5/6 20:00'")
            .setDescriptionLocalizations({
              vi: "Giờ: 20:00, 20h, 8pm, +2h, 'thứ 4 20:00', 'cn 20h', '5/6 20:00'",
              ja: "開始: 20:00、8pm、+2h、'thứ 4 20:00'、'wed 20:00'、'5/6 20:00'",
            })
            .setRequired(true)
        )
        // Required, and declared before the optional options (Discord rejects a
        // required option after an optional one).
        .addBooleanOption((option) =>
          option
            .setName("skip_notify")
            .setDescription("Silent mode: on = no pings to anyone (add/promote/cancel)")
            .setDescriptionLocalizations({
              vi: "Tắt thông báo: bật = không ping ai (add/kéo chờ/hủy)",
              ja: "サイレント: オン = 誰にも通知しない (追加/繰上/キャンセル)",
            })
            .setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName("auto_lock")
            .setDescription("Auto-lock at start time (default: true)")
            .setDescriptionLocalizations({
              vi: "Tự khóa khi tới giờ bắt đầu (mặc định: bật)",
              ja: "開始時刻に自動ロック (既定: オン)",
            })
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Optional board title")
            .setDescriptionLocalizations({
              vi: "Tiêu đề bảng (tuỳ chọn)",
              ja: "ボードタイトル (任意)",
            })
            .setRequired(false)
            .setMaxLength(80)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Resurface a board, or view your turn plans")
        .setDescriptionLocalizations({
          vi: "Đẩy lại board, hoặc xem phân turn các raid của bạn",
          ja: "ボード再表示、またはターン表を見る",
        })
        // Optional: default (omitted) = resurface, so plain `show` still bumps
        // the board exactly as before. turnplan = ephemeral turn-plan dashboard.
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("What to do (default: resurface board)")
            .setDescriptionLocalizations({
              vi: "Làm gì (mặc định: đẩy board lên)",
              ja: "操作 (既定: ボード再表示)",
            })
            .setRequired(false)
            .addChoices(
              {
                name: "📋 Resurface board",
                value: "resurface",
                name_localizations: { vi: "📋 Đẩy board lên", ja: "📋 ボードを再表示" },
              },
              {
                name: "📊 View turn plan",
                value: "turnplan",
                name_localizations: { vi: "📊 Xem phân turn", ja: "📊 ターン表を見る" },
              }
            )
        )
    );

  return raidScheduleCommand;
}

module.exports = {
  createRaidScheduleCommandDefinition,
};
