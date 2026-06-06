"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidTaskCommandDefinition() {
  const raidTaskCommand = new SlashCommandBuilder()
    .setName("raid-task")
    .setDescription("Track daily/weekly side tasks per character (cap 3 daily + 5 weekly)")
    .setDescriptionLocalizations({
      vi: "Theo dõi side task daily/weekly cho từng char (cap 3 daily + 5 weekly)",
      ja: "キャラ毎にデイリー/ウィークリーのサイドタスクを管理（上限 3 daily + 5 weekly）",
    })
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a daily or weekly side task (single char or every char in a roster)")
        .setDescriptionLocalizations({
          vi: "Thêm side task daily hoặc weekly (một char hoặc mọi char trong roster)",
          ja: "デイリー/ウィークリーのサイドタスクを追加（単体キャラ または ロスター全員）",
        })
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("single = một char cụ thể · all = mọi char trong roster")
            .setDescriptionLocalizations({
              vi: "single = một char cụ thể · all = mọi char trong roster",
              ja: "single = 単体キャラ · all = ロスター内の全キャラ",
            })
            .setRequired(true)
            .addChoices(
              {
                name: "Single character",
                name_localizations: { vi: "Một character", ja: "単体キャラ" },
                value: "single",
              },
              {
                name: "All characters in roster",
                name_localizations: {
                  vi: "Mọi character trong roster",
                  ja: "ロスター内の全キャラ",
                },
                value: "all",
              }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setDescriptionLocalizations({
              vi: "Roster (account) chứa character - autocomplete",
              ja: "キャラを含むロスター（アカウント）- オートコンプリート",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Task name (autocomplete from your past tasks, max 60 chars)")
            .setDescriptionLocalizations({
              vi: "Tên task (autocomplete từ task cũ của cậu, tối đa 60 ký tự)",
              ja: "タスク名（過去のタスクからオートコンプリート、最大60文字）",
            })
            .setRequired(true)
            .setMaxLength(60)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reset")
            .setDescription("How often this task resets")
            .setDescriptionLocalizations({
              vi: "Chu kỳ reset của task này",
              ja: "このタスクのリセット周期",
            })
            .setRequired(true)
            .addChoices(
              {
                name: "Daily (17:00 VN)",
                name_localizations: {
                  vi: "Daily (reset 17:00 VN)",
                  ja: "デイリー (リセット 19:00 JST)",
                },
                value: "daily",
              },
              {
                name: "Weekly (17:00 VN Wed)",
                name_localizations: {
                  vi: "Weekly (reset 17:00 VN thứ 4)",
                  ja: "ウィークリー (リセット 水曜 19:00 JST)",
                },
                value: "weekly",
              }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("(action=single only) Character to attach this task to - autocomplete by roster")
            .setDescriptionLocalizations({
              vi: "(chỉ khi action=single) Character gắn task này - autocomplete theo roster",
              ja: "(action=single のみ) タスクを紐付けるキャラ - ロスター単位でオートコンプリート",
            })
            .setRequired(false)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove one side task from a character")
        .setDescriptionLocalizations({
          vi: "Xóa một side task khỏi character",
          ja: "キャラから1つのサイドタスクを削除",
        })
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setDescriptionLocalizations({
              vi: "Roster (account) chứa character - autocomplete",
              ja: "キャラを含むロスター（アカウント）- オートコンプリート",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("Character to remove a task from")
            .setDescriptionLocalizations({
              vi: "Character cần xóa task",
              ja: "タスクを削除するキャラクター",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("task")
            .setDescription("Task to remove (autocomplete by character)")
            .setDescriptionLocalizations({
              vi: "Task cần xóa (autocomplete theo character)",
              ja: "削除するタスク（キャラ単位でオートコンプリート）",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Remove ALL side tasks from one character (confirm required)")
        .setDescriptionLocalizations({
          vi: "Xóa TOÀN BỘ side task của một character (yêu cầu xác nhận)",
          ja: "1キャラの全サイドタスクを削除（確認が必要）",
        })
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setDescriptionLocalizations({
              vi: "Roster (account) chứa character - autocomplete",
              ja: "キャラを含むロスター（アカウント）- オートコンプリート",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("Character to clear")
            .setDescriptionLocalizations({
              vi: "Character cần clear",
              ja: "クリアするキャラクター",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("shared-add")
        .setDescription("Add a roster-level shared task (event shop, Chaos Gate, Field Boss)")
        .setDescriptionLocalizations({
          vi: "Thêm shared task cấp roster (event shop, Chaos Gate, Field Boss)",
          ja: "ロスター単位の共有タスクを追加（イベントショップ・カオスゲート・フィールドボス）",
        })
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) to attach the shared task to")
            .setDescriptionLocalizations({
              vi: "Roster (account) để gắn shared task",
              ja: "共有タスクを紐付けるロスター（アカウント）",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("preset")
            .setDescription("Shared task preset")
            .setDescriptionLocalizations({
              vi: "Preset shared task",
              ja: "共有タスクのプリセット",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Optional display name (default comes from preset, max 60 chars)")
            .setDescriptionLocalizations({
              vi: "Tên hiển thị (tùy chọn, mặc định lấy từ preset, tối đa 60 ký tự)",
              ja: "表示名（任意、既定はプリセット由来、最大60文字）",
            })
            .setRequired(false)
            .setMaxLength(60)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reset")
            .setDescription("Manual shared task reset cycle (ignored by scheduled presets)")
            .setDescriptionLocalizations({
              vi: "Chu kỳ reset thủ công cho shared task (preset có lịch sẽ bỏ qua)",
              ja: "共有タスクの手動リセット周期（スケジュール済みプリセットでは無視）",
            })
            .setRequired(false)
            .addChoices(
              {
                name: "Daily (17:00 VN)",
                name_localizations: {
                  vi: "Daily (reset 17:00 VN)",
                  ja: "デイリー (リセット 19:00 JST)",
                },
                value: "daily",
              },
              {
                name: "Weekly (17:00 VN Wed)",
                name_localizations: {
                  vi: "Weekly (reset 17:00 VN thứ 4)",
                  ja: "ウィークリー (リセット 水曜 19:00 JST)",
                },
                value: "weekly",
              }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("expires_at")
            .setDescription("Optional expiry date for event shops, format YYYY-MM-DD")
            .setDescriptionLocalizations({
              vi: "Ngày hết hạn (tùy chọn) cho event shop, format YYYY-MM-DD",
              ja: "イベントショップの有効期限（任意、形式 YYYY-MM-DD）",
            })
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("all_rosters")
            .setDescription("Apply this shared task to all of your saved rosters")
            .setDescriptionLocalizations({
              vi: "Áp shared task này cho tất cả roster đã lưu của cậu",
              ja: "保存済みの全ロスターにこの共有タスクを適用",
            })
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("shared-remove")
        .setDescription("Remove one roster-level shared task")
        .setDescriptionLocalizations({
          vi: "Xóa một shared task cấp roster",
          ja: "ロスター単位の共有タスクを1つ削除",
        })
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) containing the shared task")
            .setDescriptionLocalizations({
              vi: "Roster (account) chứa shared task",
              ja: "共有タスクを含むロスター（アカウント）",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("task")
            .setDescription("Shared task to remove")
            .setDescriptionLocalizations({
              vi: "Shared task cần xóa",
              ja: "削除する共有タスク",
            })
            .setRequired(true)
            .setAutocomplete(true)
        )
    );

  return raidTaskCommand;
}

module.exports = {
  createRaidTaskCommandDefinition,
};
