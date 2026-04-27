"use strict";

const { buildNoticeEmbed } = require("../raid/shared");

const TASK_CAP_DAILY = 3;
const TASK_CAP_WEEKLY = 5;

function generateTaskId() {
  // 10-char base36 from random + timestamp suffix. Collision risk is
  // negligible at our scale (per-character scope, max 8 tasks per char)
  // and avoids pulling in a uuid dep just to namespace eight items.
  return (
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function getCharacterDisplayName(character) {
  return String(character?.name || "").trim();
}

function findCharacterInUser(userDoc, characterName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(characterName);
  if (!target) return null;
  for (const account of userDoc.accounts) {
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterDisplayName(character)) === target) {
        return { account, character };
      }
    }
  }
  return null;
}

function ensureSideTasks(character) {
  if (!Array.isArray(character.sideTasks)) {
    character.sideTasks = [];
  }
  return character.sideTasks;
}

function countByReset(sideTasks, reset) {
  return sideTasks.filter((t) => t?.reset === reset).length;
}

function createRaidTaskCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    User,
    saveWithRetry,
    loadUserForAutocomplete,
  } = deps;

  async function autocompleteCharacter(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const entries = [];
    const seen = new Set();
    for (const account of userDoc.accounts) {
      const chars = Array.isArray(account.characters) ? account.characters : [];
      for (const character of chars) {
        const name = getCharacterDisplayName(character);
        const normalized = normalizeName(name);
        if (!name || seen.has(normalized)) continue;
        if (needle && !normalized.includes(needle)) continue;
        seen.add(normalized);
        const sideTaskCount = Array.isArray(character.sideTasks)
          ? character.sideTasks.length
          : 0;
        entries.push({
          name,
          className: String(character.class || ""),
          itemLevel: Number(character.itemLevel) || 0,
          sideTaskCount,
        });
      }
    }
    entries.sort(
      (a, b) => b.itemLevel - a.itemLevel || a.name.localeCompare(b.name)
    );
    const choices = entries.slice(0, 25).map((entry) => {
      const taskSuffix =
        entry.sideTaskCount > 0 ? ` · ${entry.sideTaskCount} task` : "";
      const label = `${entry.name} · ${entry.className} · ${entry.itemLevel}${taskSuffix}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: entry.name.length > 100 ? entry.name.slice(0, 100) : entry.name,
      };
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteTask(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const characterInput = interaction.options.getString("character") || "";
    const discordId = interaction.user.id;
    if (!characterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(discordId);
    const found = findCharacterInUser(userDoc, characterInput);
    if (!found) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const sideTasks = Array.isArray(found.character.sideTasks)
      ? found.character.sideTasks
      : [];
    const choices = sideTasks
      .filter((t) => !needle || normalizeName(t?.name).includes(needle))
      .slice(0, 25)
      .map((task) => {
        const icon = task.reset === "daily" ? "🌒" : "📅";
        const label = `${icon} ${task.name} · ${task.reset}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          value: task.taskId,
        };
      });
    await interaction.respond(choices).catch(() => {});
  }

  async function handleRaidTaskAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === "character") {
        await autocompleteCharacter(interaction, focused);
        return;
      }
      if (focused?.name === "task") {
        await autocompleteTask(interaction, focused);
        return;
      }
      await interaction.respond([]).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] raid-task error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }

  async function handleAdd(interaction) {
    const discordId = interaction.user.id;
    const characterName = interaction.options.getString("character", true);
    const taskName = interaction.options.getString("name", true).trim();
    const reset = interaction.options.getString("reset", true);

    if (!taskName) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Tên task không hợp lệ",
            description: "Tên task không được để trống nha. Gõ lại với nội dung mô tả ngắn gọn.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let outcome = "added";
    let resolvedCharName = "";
    let dailyCount = 0;
    let weeklyCount = 0;

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const found = findCharacterInUser(userDoc, characterName);
        if (!found) {
          outcome = "no-character";
          return;
        }
        const character = found.character;
        const sideTasks = ensureSideTasks(character);
        resolvedCharName = getCharacterDisplayName(character);

        const cap = reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
        const currentCount = countByReset(sideTasks, reset);
        if (currentCount >= cap) {
          outcome = "cap-reached";
          dailyCount = countByReset(sideTasks, "daily");
          weeklyCount = countByReset(sideTasks, "weekly");
          return;
        }

        const dupName = sideTasks.some(
          (t) => normalizeName(t?.name) === normalizeName(taskName) && t?.reset === reset
        );
        if (dupName) {
          outcome = "duplicate";
          return;
        }

        sideTasks.push({
          taskId: generateTaskId(),
          name: taskName,
          reset,
          completed: false,
          lastResetAt: 0,
          createdAt: Date.now(),
        });
        dailyCount = countByReset(sideTasks, "daily");
        weeklyCount = countByReset(sideTasks, "weekly");
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task add] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi lưu task. Thử lại sau ít phút, nếu vẫn fail thì ping ops nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (outcome === "no-roster") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Cậu chưa có roster",
            description: "Artist chưa thấy roster nào của cậu. Chạy `/add-roster` trước rồi mới đăng ký task được.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "no-character") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy character",
            description: `Artist không tìm thấy **${characterName}** trong roster của cậu. Dùng autocomplete khi gõ field \`character:\` để tránh sai tên nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "cap-reached") {
      const cap = reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Đã đầy slot",
            description: [
              `**${resolvedCharName}** đã đủ **${cap} task ${reset}** rồi nha. Cap cứng để list không bị loãng.`,
              "",
              `**Hiện tại:** ${dailyCount}/${TASK_CAP_DAILY} daily · ${weeklyCount}/${TASK_CAP_WEEKLY} weekly`,
              "**Cách giải:** Gõ `/raid-task remove` xoá task cũ trước, rồi mới add task mới.",
            ].join("\n"),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "duplicate") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Task đã tồn tại",
            description: `Char **${resolvedCharName}** đã có task \`${taskName}\` cùng cycle \`${reset}\` rồi. Đặt tên khác hoặc đổi cycle nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: "Đã thêm side task",
          description: [
            `**Character:** ${resolvedCharName}`,
            `**Task:** ${taskName}`,
            `**Cycle:** ${reset === "daily" ? "Daily (reset 17:00 VN)" : "Weekly (reset 17:00 VN thứ 4)"}`,
            "",
            `**Slot còn lại:** ${TASK_CAP_DAILY - dailyCount} daily · ${TASK_CAP_WEEKLY - weeklyCount} weekly`,
            "Vào `/raid-status` rồi đổi sang **Task view** để toggle complete nha.",
          ].join("\n"),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleRemove(interaction) {
    const discordId = interaction.user.id;
    const characterName = interaction.options.getString("character", true);
    const taskId = interaction.options.getString("task", true);

    let outcome = "removed";
    let resolvedCharName = "";
    let removedTaskName = "";

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const found = findCharacterInUser(userDoc, characterName);
        if (!found) {
          outcome = "no-character";
          return;
        }
        resolvedCharName = getCharacterDisplayName(found.character);
        const sideTasks = ensureSideTasks(found.character);
        const idx = sideTasks.findIndex((t) => t?.taskId === taskId);
        if (idx === -1) {
          outcome = "task-not-found";
          return;
        }
        removedTaskName = sideTasks[idx]?.name || "(không tên)";
        sideTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task remove] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi xoá task. Thử lại sau ít phút nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-character") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy character",
            description: `Artist không tìm thấy **${characterName}** trong roster của cậu. Dùng autocomplete khi gõ field \`character:\` nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "task-not-found") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Task đã không còn",
            description: "Task này có vẻ đã bị xoá từ trước (hoặc autocomplete trỏ tới id không còn tồn tại). Refresh `/raid-status` để xem list mới nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: "Đã xoá task",
          description: [
            `**Character:** ${resolvedCharName}`,
            `**Task vừa xoá:** ${removedTaskName}`,
          ].join("\n"),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleClear(interaction) {
    const discordId = interaction.user.id;
    const characterName = interaction.options.getString("character", true);

    const userDoc = await User.findOne({ discordId }).lean();
    const found = userDoc ? findCharacterInUser(userDoc, characterName) : null;
    if (!found) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy character",
            description: `Artist không tìm thấy **${characterName}** trong roster của cậu. Dùng autocomplete khi gõ field \`character:\` nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const resolvedCharName = getCharacterDisplayName(found.character);
    const sideTasks = Array.isArray(found.character.sideTasks)
      ? found.character.sideTasks
      : [];
    if (sideTasks.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Không có gì để clear",
            description: `**${resolvedCharName}** chưa có side task nào nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dailyCount = countByReset(sideTasks, "daily");
    const weeklyCount = countByReset(sideTasks, "weekly");

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`raid-task:clear-confirm:${encodeURIComponent(resolvedCharName)}`)
        .setLabel(`Xoá toàn bộ ${sideTasks.length} task`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("raid-task:clear-cancel")
        .setLabel("Huỷ")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: "Xác nhận xoá toàn bộ",
          description: [
            `Cậu sắp xoá **${sideTasks.length} task** của **${resolvedCharName}**:`,
            `· ${dailyCount} daily`,
            `· ${weeklyCount} weekly`,
            "",
            "Hành động này không undo được. Bấm nút bên dưới để xác nhận hoặc huỷ.",
          ].join("\n"),
        }),
      ],
      components: [confirmRow],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleClearConfirmButton(interaction) {
    const parts = (interaction.customId || "").split(":");
    const charNameEncoded = parts[2] || "";
    const characterName = decodeURIComponent(charNameEncoded);
    const discordId = interaction.user.id;

    let outcome = "cleared";
    let resolvedCharName = characterName;
    let removedCount = 0;

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc) {
          outcome = "no-roster";
          return;
        }
        const found = findCharacterInUser(userDoc, characterName);
        if (!found) {
          outcome = "no-character";
          return;
        }
        resolvedCharName = getCharacterDisplayName(found.character);
        const sideTasks = ensureSideTasks(found.character);
        removedCount = sideTasks.length;
        found.character.sideTasks = [];
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task clear] save failed:", error?.message || error);
      await interaction.update({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi clear. Thử lại sau ít phút nha.",
          }),
        ],
        components: [],
      }).catch(() => {});
      return;
    }

    if (outcome === "no-roster" || outcome === "no-character") {
      await interaction.update({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Character không còn",
            description: "Character này có vẻ vừa bị xoá khỏi roster. Refresh `/raid-status` nha.",
          }),
        ],
        components: [],
      }).catch(() => {});
      return;
    }

    await interaction.update({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: "Đã clear",
          description: `Đã xoá **${removedCount} task** của **${resolvedCharName}**.`,
        }),
      ],
      components: [],
    }).catch(() => {});
  }

  async function handleClearCancelButton(interaction) {
    await interaction.update({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "muted",
          title: "Đã huỷ",
          description: "Không xoá gì cả nha~",
        }),
      ],
      components: [],
    }).catch(() => {});
  }

  async function handleRaidTaskButton(interaction) {
    const customId = interaction.customId || "";
    if (customId.startsWith("raid-task:clear-confirm:")) {
      await handleClearConfirmButton(interaction);
      return;
    }
    if (customId === "raid-task:clear-cancel") {
      await handleClearCancelButton(interaction);
      return;
    }
  }

  async function handleRaidTaskCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "add") return handleAdd(interaction);
    if (sub === "remove") return handleRemove(interaction);
    if (sub === "clear") return handleClear(interaction);
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: "Subcommand không hợp lệ",
          description: `Subcommand \`${sub}\` Artist không nhận được. Cho phép: \`add\` · \`remove\` · \`clear\`.`,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  return {
    handleRaidTaskCommand,
    handleRaidTaskAutocomplete,
    handleRaidTaskButton,
  };
}

module.exports = {
  createRaidTaskCommand,
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  generateTaskId,
  findCharacterInUser,
  countByReset,
  ensureSideTasks,
};
