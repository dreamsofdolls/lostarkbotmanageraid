"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidCommandDefinitions({
  announcementTypeKeys,
  announcementTypeEntry,
}) {
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
  const raidCheckCommand = new SlashCommandBuilder()
    .setName("raid-check")
    .setDescription("(Raid Leader) Cross-raid overview of guild progress")
    .setDescriptionLocalizations({
      vi: "(Raid Leader) Tổng quan tiến độ raid của cả guild",
      ja: "(Raid Leader) ギルド全体のレイド進捗一覧",
    });

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

  const statusCommand = new SlashCommandBuilder()
    .setName("raid-status")
    .setDescription("View your raid progress")
    .setDescriptionLocalizations({
      vi: "Xem tiến độ raid của cậu",
      ja: "あなたのレイド進捗を表示",
    });

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
        // Autocomplete (not static choices) so we can hide redundant +
        // mutex-blocked actions from the dropdown. Six actions total
        // (bible on/off/sync, local on/off, status); filter logic lives
        // in handleRaidAutoManageAutocomplete and reads both flags.
        .setAutocomplete(true)
    );


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

  const raidBgCommand = new SlashCommandBuilder()
    .setName("raid-bg")
    .setDescription("Set / view / remove background image for your /raid-status card")
    .setDescriptionLocalizations({
      vi: "Set / xem / xoá ảnh background cho card /raid-status",
      ja: "/raid-status カードの背景画像を設定 / 表示 / 削除",
    })
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Upload 1-4 roster background images (1600x900+, 8MB each)")
        .setDescriptionLocalizations({
          vi: "Upload 1-4 ảnh background roster (1600x900+, tối đa 8MB mỗi ảnh)",
          ja: "1-4枚のroster背景画像をアップロード（1600x900以上、各8MBまで）",
        })
        .addAttachmentOption((opt) =>
          opt
            .setName("image")
            .setDescription("First background image file (PNG/JPG/WEBP, 1600x900+, 8MB max)")
            .setDescriptionLocalizations({
              vi: "File background đầu tiên (PNG/JPG/WEBP, 1600x900+, max 8MB)",
              ja: "1枚目の背景画像ファイル（PNG/JPG/WEBP、1600x900以上、最大8MB）",
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
        .setName("remove")
        .setDescription("Remove your background · revert /raid-status to the text embed")
        .setDescriptionLocalizations({
          vi: "Xoá background · /raid-status quay về text embed",
          ja: "背景を削除 · /raid-status をテキスト埋め込みに戻す",
        }),
    );

  const raidLanguageCommand = new SlashCommandBuilder()
    .setName("raid-language")
    .setDescription("Đổi ngôn ngữ Artist hiển thị cho cậu (Tiếng Việt / 日本語)")
    .setDescriptionLocalizations({
      vi: "Đổi ngôn ngữ Artist hiển thị cho cậu (Tiếng Việt / 日本語)",
      ja: "Artist の表示言語を切り替え（Tiếng Việt / 日本語）",
    })
    .setDMPermission(false);

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

  const commands = [
    addRosterCommand,
    editRosterCommand,
    raidCheckCommand,
    raidSetCommand,
    statusCommand,
    raidHelpCommand,
    raidGoldEarnerCommand,
    removeRosterCommand,
    raidChannelCommand,
    raidAutoManageCommand,
    raidAnnounceCommand,
    raidTaskCommand,
    raidShareCommand,
    raidLanguageCommand,
    raidBgCommand,
  ];

  return commands;
}

module.exports = {
  createRaidCommandDefinitions,
};
