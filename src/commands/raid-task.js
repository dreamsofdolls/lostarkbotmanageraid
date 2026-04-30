"use strict";

const { buildNoticeEmbed } = require("../raid/shared");
const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../raid/autocomplete-helpers");
const {
  SCHEDULED_RESET,
  SHARED_TASK_PRESETS,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  getSharedTaskPreset,
  ensureSharedTasks,
  countSharedTasksByReset,
  sharedTaskCapForReset,
  parseSharedTaskExpiresAt,
  getVisibleSharedTasks,
  getSharedTaskDisplay,
  formatSharedResetLabel,
} = require("../raid/shared-tasks");

// User-facing reset label that includes the actual VN reset moment so the
// shared-add reply / cap-reached / duplicate notices read as a complete
// sentence instead of interpolating the raw `daily`/`weekly`/`scheduled`
// keyword from the schema. Scheduled presets get the timezone hint since
// they don't follow the 17:00 VN cycle.
function formatSharedResetDetail(reset) {
  if (reset === "daily") return "Daily (reset 17:00 VN)";
  if (reset === "weekly") return "Weekly (reset 17:00 VN thứ 4)";
  if (reset === SCHEDULED_RESET) return "Theo lịch NA West (Pacific)";
  return formatSharedResetLabel(reset);
}

const TASK_CAP_DAILY = 3;
const TASK_CAP_WEEKLY = 5;
const SHARED_TASK_PRESET_ORDER = [
  "event_shop",
  "chaos_gate",
  "field_boss",
  "custom",
];

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

function isLiveSharedTask(task, nowMs = Date.now()) {
  if (!task || Number(task.archivedAt) > 0) return false;
  const expiresAt = Number(task.expiresAt) || 0;
  return !(expiresAt > 0 && expiresAt < nowMs);
}

function sharedTaskHasPreset(account, presetKey, nowMs = Date.now()) {
  return ensureSharedTasks(account).some(
    (task) => isLiveSharedTask(task, nowMs) && task?.preset === presetKey
  );
}

function isDuplicateSharedTask(sharedTasks, preset, taskName, reset, nowMs = Date.now()) {
  return (Array.isArray(sharedTasks) ? sharedTasks : []).some((task) => {
    if (!isLiveSharedTask(task, nowMs)) return false;
    if (preset.preset !== "custom" && task.preset === preset.preset) {
      return true;
    }
    if (preset.kind === "scheduled") {
      return task.preset === preset.preset;
    }
    return (
      normalizeName(task.name) === normalizeName(taskName) &&
      task.reset === reset
    );
  });
}

function sharedPresetLabel(preset) {
  if (preset.preset === "chaos_gate") return "Chaos Gate (NA West PT)";
  if (preset.preset === "field_boss") return "Field Boss (NA West PT)";
  return preset.label;
}

function getCharacterDisplayName(character) {
  return String(character?.name || "").trim();
}

// Resolve a single (account, character) pair from a user doc. When
// `rosterName` is supplied (slash command path - the field is required so
// callers always pass it), the search is scoped to just that account so
// same-named chars across rosters can't collide. When omitted (legacy
// callers / tests), falls back to first-by-iteration match across every
// account so older invocation paths keep working.
function findCharacterInUser(userDoc, characterName, rosterName = null) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(characterName);
  if (!target) return null;
  const rosterTarget = rosterName ? normalizeName(rosterName) : null;
  for (const account of userDoc.accounts) {
    if (rosterTarget && normalizeName(account.accountName) !== rosterTarget) {
      continue;
    }
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterDisplayName(character)) === target) {
        return { account, character };
      }
    }
  }
  return null;
}

function findAccountInUser(userDoc, rosterName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(rosterName);
  if (!target) return null;
  return (
    userDoc.accounts.find((account) => normalizeName(account?.accountName) === target) ||
    null
  );
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
    dailyResetStartMs,
    weekResetStartMs,
  } = deps;

  async function autocompleteRoster(interaction, focused) {
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = matches.map((a) => {
      const chars = Array.isArray(a.characters) ? a.characters : [];
      const taskTotal = chars.reduce(
        (sum, c) => sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
        0
      );
      const taskSuffix = taskTotal > 0 ? ` · ${taskTotal} task` : "";
      const label = `📁 ${a.accountName} · ${chars.length} char${chars.length === 1 ? "" : "s"}${taskSuffix}`;
      return truncateChoice(label, a.accountName);
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteCharacter(interaction, focused) {
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: interaction.options.getString("roster") || null,
      needle: focused.value || "",
    });
    const choices = entries.map((entry) => {
      const taskSuffix =
        entry.sideTaskCount > 0 ? ` · ${entry.sideTaskCount} task` : "";
      const label = `${entry.name} · ${entry.className} · ${entry.itemLevel}${taskSuffix}`;
      return truncateChoice(label, entry.name);
    });
    await interaction.respond(choices).catch(() => {});
  }

  // Suggest task names from the user's existing side tasks across every
  // character + roster, deduped by (name, reset) pair. Sorted by recency
  // (most recent createdAt first) so a chore the user just registered
  // bubbles to the top when they /raid-task add for another char. Reset
  // cycle is annotated in the suggestion label so the user can spot the
  // distinction when same name lives across both cycles ("Una" daily vs
  // "Una" weekly are 2 different suggestions).
  async function autocompleteTaskName(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const seenKey = new Set();
    const candidates = [];
    for (const account of userDoc.accounts) {
      const chars = Array.isArray(account.characters) ? account.characters : [];
      for (const character of chars) {
        const tasks = Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
        for (const task of tasks) {
          if (!task?.name) continue;
          const key = `${normalizeName(task.name)}::${task.reset}`;
          if (seenKey.has(key)) continue;
          if (needle && !normalizeName(task.name).includes(needle)) continue;
          seenKey.add(key);
          candidates.push({
            name: task.name,
            reset: task.reset,
            createdAt: Number(task.createdAt) || 0,
          });
        }
      }
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    const choices = candidates.slice(0, 25).map((c) => {
      const label = `${c.name} · ${c.reset}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: c.name.length > 100 ? c.name.slice(0, 100) : c.name,
      };
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteTask(interaction, focused) {
    const subcommand = typeof interaction.options.getSubcommand === "function"
      ? interaction.options.getSubcommand(false)
      : "";
    if (subcommand === "shared-remove") {
      await autocompleteSharedTask(interaction, focused);
      return;
    }

    const needle = normalizeName(focused.value || "");
    const characterInput = interaction.options.getString("character") || "";
    const rosterInput = interaction.options.getString("roster") || "";
    const discordId = interaction.user.id;
    if (!characterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(discordId);
    const found = findCharacterInUser(userDoc, characterInput, rosterInput || null);
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

  async function autocompleteSharedTask(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const discordId = interaction.user.id;
    if (!rosterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(discordId);
    const account = findAccountInUser(userDoc, rosterInput);
    if (!account) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const now = new Date();
    const choices = getVisibleSharedTasks(account, now.getTime())
      .filter((task) => !needle || normalizeName(task?.name).includes(needle))
      .slice(0, 25)
      .map((task) => {
        const display = getSharedTaskDisplay(task, now);
        return truncateChoice(
          `${display.emoji} ${display.name} · ${display.status}`,
          task.taskId
        );
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteSharedPreset(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
    const selectedAccount = rosterInput
      ? findAccountInUser(userDoc, rosterInput)
      : null;
    const now = Date.now();

    const choices = SHARED_TASK_PRESET_ORDER
      .map((presetKey) => SHARED_TASK_PRESETS[presetKey])
      .filter(Boolean)
      .map((preset) => {
        const label = sharedPresetLabel(preset);
        let status = "";
        if (preset.preset === "custom") {
          status = "có thể thêm nhiều";
        } else if (selectedAccount) {
          status = sharedTaskHasPreset(selectedAccount, preset.preset, now)
            ? "đã thêm"
            : "chưa thêm";
        } else if (accounts.length > 0) {
          const count = accounts.filter((account) =>
            sharedTaskHasPreset(account, preset.preset, now)
          ).length;
          status = count > 0
            ? `đã thêm ${count}/${accounts.length} roster`
            : "chưa thêm";
        } else {
          status = "chưa có roster";
        }

        return {
          label,
          value: preset.preset,
          choice: truncateChoice(`${label} · ${status}`, preset.preset),
        };
      })
      .filter(
        (entry) =>
          !needle ||
          normalizeName(entry.label).includes(needle) ||
          normalizeName(entry.value).includes(needle)
      )
      .slice(0, 25)
      .map((entry) => entry.choice);

    await interaction.respond(choices).catch(() => {});
  }

  async function handleRaidTaskAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === "roster") {
        await autocompleteRoster(interaction, focused);
        return;
      }
      if (focused?.name === "character") {
        await autocompleteCharacter(interaction, focused);
        return;
      }
      if (focused?.name === "task") {
        await autocompleteTask(interaction, focused);
        return;
      }
      if (focused?.name === "preset") {
        await autocompleteSharedPreset(interaction, focused);
        return;
      }
      if (focused?.name === "name") {
        await autocompleteTaskName(interaction, focused);
        return;
      }
      await interaction.respond([]).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] raid-task error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }

  async function handleAddSingle(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true);
    // `character` is optional at the Discord schema level (because the
    // sibling action=all branch doesn't need it) but required at runtime
    // for action=single. The dispatcher already routed us here, so error
    // out with a clear hint when the user picked single without filling
    // the field.
    const characterName = interaction.options.getString("character", false);
    const taskName = interaction.options.getString("name", true).trim();
    const reset = interaction.options.getString("reset", true);

    if (!characterName) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Thiếu character",
            description: "Action `single` cần field `character`. Hoặc đổi action sang `all` để add cho mọi char trong roster nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
        const found = findCharacterInUser(userDoc, characterName, rosterName);
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

        // Seed lastResetAt to the CURRENT cycle's start so the scheduler
        // tick treats this task as "already in sync with this cycle" - not
        // as a stale legacy entry that needs an immediate reset. Without
        // this, a user who adds a daily task at 20:00 VN and toggles it
        // complete will see it flipped back to ⬜ on the next 30-min tick
        // because lastResetAt=0 < dailyResetStartMs(now). Codex round 28
        // finding #1.
        const cycleStart =
          reset === "daily" ? dailyResetStartMs() : weekResetStartMs();
        sideTasks.push({
          taskId: generateTaskId(),
          name: taskName,
          reset,
          completed: false,
          lastResetAt: cycleStart,
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

  // Add the same task to every character in a single roster. Each char
  // is independently checked for cap (3 daily / 5 weekly) + duplicate
  // (same name + same reset cycle); chars that fail either check are
  // skipped and surfaced in the summary so the user knows which need
  // manual handling. Single Mongo write per invocation regardless of
  // char count.
  async function handleAddAll(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true);
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

    const added = [];
    const skippedCap = [];
    const skippedDup = [];
    let outcome = "ok";
    let resolvedRosterName = rosterName;

    try {
      await saveWithRetry(async () => {
        added.length = 0;
        skippedCap.length = 0;
        skippedDup.length = 0;
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const targetRoster = normalizeName(rosterName);
        const account = userDoc.accounts.find(
          (a) => normalizeName(a.accountName) === targetRoster
        );
        if (!account) {
          outcome = "no-roster-match";
          return;
        }
        resolvedRosterName = account.accountName;
        const characters = Array.isArray(account.characters)
          ? account.characters
          : [];
        if (characters.length === 0) {
          outcome = "empty-roster";
          return;
        }

        const cap = reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
        const cycleStart =
          reset === "daily" ? dailyResetStartMs() : weekResetStartMs();
        const taskNameNormalized = normalizeName(taskName);

        for (const character of characters) {
          const sideTasks = ensureSideTasks(character);
          const charName = getCharacterDisplayName(character);
          if (countByReset(sideTasks, reset) >= cap) {
            skippedCap.push(charName);
            continue;
          }
          const dup = sideTasks.some(
            (t) =>
              normalizeName(t?.name) === taskNameNormalized &&
              t?.reset === reset
          );
          if (dup) {
            skippedDup.push(charName);
            continue;
          }
          sideTasks.push({
            taskId: generateTaskId(),
            name: taskName,
            reset,
            completed: false,
            lastResetAt: cycleStart,
            createdAt: Date.now(),
          });
          added.push(charName);
        }

        if (added.length > 0) {
          await userDoc.save();
        }
      });
    } catch (error) {
      console.error("[raid-task add-all] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi lưu task. Thử lại sau ít phút nha.",
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
    if (outcome === "no-roster-match") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy roster",
            description: `Artist không tìm thấy roster **${rosterName}** của cậu. Dùng autocomplete khi gõ field \`roster:\` để tránh sai tên nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "empty-roster") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Roster rỗng",
            description: `Roster **${resolvedRosterName}** không có character nào để add task.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (added.length === 0 && skippedCap.length === 0 && skippedDup.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Không có gì để thêm",
            description: `Roster **${resolvedRosterName}** không có character phù hợp.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const totalChars = added.length + skippedCap.length + skippedDup.length;
    const lines = [
      `**Roster:** ${resolvedRosterName}`,
      `**Task:** ${taskName}`,
      `**Cycle:** ${reset === "daily" ? "Daily (reset 17:00 VN)" : "Weekly (reset 17:00 VN thứ 4)"}`,
      "",
      `**Added:** ${added.length}/${totalChars} character${added.length === 1 ? "" : "s"}`,
    ];
    if (added.length > 0) {
      lines.push(`> ${added.join(", ")}`);
    }
    if (skippedDup.length > 0) {
      lines.push("");
      lines.push(`**Skipped (đã có task này):** ${skippedDup.length}`);
      lines.push(`> ${skippedDup.join(", ")}`);
    }
    if (skippedCap.length > 0) {
      lines.push("");
      lines.push(
        `**Skipped (đã đủ ${reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY} task ${reset}):** ${skippedCap.length}`
      );
      lines.push(`> ${skippedCap.join(", ")}`);
    }

    const type = added.length > 0 ? "success" : "info";
    const title =
      added.length > 0
        ? `Đã thêm task cho ${added.length} char`
        : "Không có char nào được thêm";
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type,
          title,
          description: lines.join("\n"),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  function resolveSharedTaskReset(preset, requestedReset) {
    if (preset.kind === "scheduled") return SCHEDULED_RESET;
    if (requestedReset === "daily" || requestedReset === "weekly") {
      return requestedReset;
    }
    return preset.reset || "weekly";
  }

  async function handleSharedAdd(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true);
    const presetKey = interaction.options.getString("preset", true);
    const preset = getSharedTaskPreset(presetKey);
    const requestedReset = interaction.options.getString("reset", false);
    const reset = resolveSharedTaskReset(preset, requestedReset);
    const taskNameInput = interaction.options.getString("name", false);
    const taskName = String(taskNameInput || preset.defaultName).trim();
    const expiresRaw = interaction.options.getString("expires_at", false);
    const expiresAt = parseSharedTaskExpiresAt(expiresRaw);
    const applyAllRosters =
      typeof interaction.options.getBoolean === "function" &&
      interaction.options.getBoolean("all_rosters", false) === true;

    if (!SHARED_TASK_PRESETS[presetKey]) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Preset không hợp lệ",
            description: "Artist chỉ nhận các preset trong autocomplete: `event_shop`, `chaos_gate`, `field_boss`, `custom`.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!taskName) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Tên task không hợp lệ",
            description: "Task chung cần có tên. Với preset custom, cậu điền field `name:` giúp tớ nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (Number.isNaN(expiresAt)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Ngày hết hạn không hợp lệ",
            description: "Field `expires_at` dùng format `YYYY-MM-DD`, ví dụ `2026-05-20`.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (expiresAt && expiresAt < Date.now()) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Ngày hết hạn đã qua",
            description: "Task vừa thêm sẽ bị ẩn ngay nếu `expires_at` nằm trong quá khứ. Cậu chỉnh lại ngày rồi thử lại nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let outcome = "added";
    let resolvedRosterName = rosterName;
    let countForReset = 0;
    let targetRosterCount = 0;
    const addedRosters = [];
    const skippedDup = [];
    const skippedCap = [];
    const now = Date.now();

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const targetAccounts = applyAllRosters
          ? userDoc.accounts.filter((account) => account?.accountName)
          : [findAccountInUser(userDoc, rosterName)].filter(Boolean);
        if (targetAccounts.length === 0) {
          outcome = "no-roster-match";
          return;
        }
        targetRosterCount = targetAccounts.length;
        resolvedRosterName = targetAccounts[0]?.accountName || rosterName;

        for (const account of targetAccounts) {
          const sharedTasks = ensureSharedTasks(account);
          const cap = sharedTaskCapForReset(reset);
          const currentCount = countSharedTasksByReset(sharedTasks, reset, now);
          if (currentCount >= cap) {
            countForReset = currentCount;
            skippedCap.push(`${account.accountName} (${currentCount}/${cap})`);
            if (!applyAllRosters) {
              outcome = "cap-reached";
              return;
            }
            continue;
          }

          if (isDuplicateSharedTask(sharedTasks, preset, taskName, reset, now)) {
            skippedDup.push(account.accountName);
            if (!applyAllRosters) {
              outcome = "duplicate";
              return;
            }
            continue;
          }

          const cycleStart =
            reset === "daily"
              ? dailyResetStartMs()
              : reset === "weekly"
                ? weekResetStartMs()
                : 0;
          sharedTasks.push({
            taskId: generateTaskId(),
            preset: preset.preset,
            name: taskName,
            reset,
            completed: false,
            completedAt: null,
            completedForKey: "",
            lastResetAt: cycleStart,
            createdAt: now,
            expiresAt,
            archivedAt: null,
            timezone: preset.timeZone || "America/Los_Angeles",
          });
          countForReset = currentCount + 1;
          addedRosters.push(account.accountName);
        }

        if (applyAllRosters && addedRosters.length === 0) {
          outcome = "none-added";
          return;
        }
        if (addedRosters.length > 0) {
          await userDoc.save();
        }
      });
    } catch (error) {
      console.error("[raid-task shared-add] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi lưu task chung. Thử lại sau ít phút nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-roster-match") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy roster",
            description: `Artist không tìm thấy roster **${rosterName}** của cậu. Dùng autocomplete khi gõ field \`roster:\` để tránh sai tên nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "none-added") {
      const lines = [
        `**Task:** ${preset.emoji} ${taskName}`,
        `**Loại:** ${preset.label}`,
        `**Rosters kiểm tra:** ${targetRosterCount}`,
      ];
      if (skippedDup.length > 0) {
        lines.push(`**Đã có sẵn:** ${skippedDup.join(", ")}`);
      }
      if (skippedCap.length > 0) {
        lines.push(`**Đầy slot:** ${skippedCap.join(", ")}`);
      }
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Không có roster mới được thêm",
            description: lines.join("\n"),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "cap-reached") {
      const cap = sharedTaskCapForReset(reset);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Đã đầy slot task chung",
            description: `Roster **${resolvedRosterName}** đầy **${countForReset}/${cap}** task chung **${formatSharedResetDetail(reset)}** rồi nha cậu. Xoá bớt bằng \`/raid-task shared-remove\` trước, rồi tớ mới gắn thêm được.`,
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
            title: "Task chung đã tồn tại",
            description: preset.kind === "scheduled"
              ? `Roster **${resolvedRosterName}** gắn preset **${preset.label}** từ trước rồi, tớ không add chồng nha~`
              : `Roster **${resolvedRosterName}** đã có task \`${taskName}\` (${formatSharedResetDetail(reset)}) rồi nha. Đặt tên khác hoặc đổi cycle nếu cậu muốn add cái mới.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = [
      "Artist đã ghi vào sổ rồi nha~",
      applyAllRosters
        ? `**Rosters:** ${addedRosters.length}/${targetRosterCount} roster`
        : `**Roster:** ${resolvedRosterName}`,
      ...(applyAllRosters && skippedDup.length > 0
        ? [`**Đã có sẵn nên bỏ qua:** ${skippedDup.join(", ")}`]
        : []),
      ...(applyAllRosters && skippedCap.length > 0
        ? [`**Đầy slot nên bỏ qua:** ${skippedCap.join(", ")}`]
        : []),
      `**Task:** ${preset.emoji} ${taskName}`,
      `**Loại:** ${preset.label}`,
      `**Reset:** ${formatSharedResetDetail(reset)}`,
    ];
    if (preset.scheduleText) lines.push(`**Lịch:** ${preset.scheduleText}`);
    if (expiresAt) {
      lines.push(`**Hết hạn:** <t:${Math.floor(expiresAt / 1000)}:D>`);
    }
    lines.push("");
    lines.push("Vào `/raid-status` → dropdown **📝 Side tasks** rồi bấm task chung trong list để toggle nha.");

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: "Đã thêm task chung",
          description: lines.join("\n"),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleSharedRemove(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true);
    const taskId = interaction.options.getString("task", true);

    let outcome = "removed";
    let resolvedRosterName = rosterName;
    let removedTaskName = "";

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const account = findAccountInUser(userDoc, rosterName);
        if (!account) {
          outcome = "no-roster-match";
          return;
        }
        resolvedRosterName = account.accountName;
        const sharedTasks = ensureSharedTasks(account);
        const idx = sharedTasks.findIndex((task) => task?.taskId === taskId);
        if (idx === -1) {
          outcome = "task-not-found";
          return;
        }
        removedTaskName = sharedTasks[idx]?.name || "(không tên)";
        sharedTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task shared-remove] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: "Save thất bại",
            description: "Mongo trả lỗi khi xoá task chung. Thử lại sau ít phút nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-roster-match") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy roster",
            description: `Artist không tìm thấy roster **${rosterName}** của cậu.`,
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
            title: "Task chung đã không còn",
            description: "Task này có vẻ đã bị xoá từ trước. Gõ lại `/raid-status` hoặc dùng autocomplete mới nha.",
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
          title: "Đã xoá task chung",
          description: [
            `**Roster:** ${resolvedRosterName}`,
            `**Task vừa xoá:** ${removedTaskName}`,
          ].join("\n"),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleRemove(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true);
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
        const found = findCharacterInUser(userDoc, characterName, rosterName);
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
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);

    const userDoc = await User.findOne({ discordId }).lean();
    const found = userDoc
      ? findCharacterInUser(userDoc, characterName, rosterName)
      : null;
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

    const resolvedRosterName = found.account.accountName || rosterName;
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `raid-task:clear-confirm:${encodeURIComponent(resolvedRosterName)}:${encodeURIComponent(resolvedCharName)}`
        )
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
    // CustomId shape: `raid-task:clear-confirm:<encodedRoster>:<encodedChar>`.
    // Legacy clear-confirm without roster (single colon-segment in slot 2)
    // falls back to first-by-iteration char match for backward-compat with
    // pending sessions from before the roster-required deploy.
    const parts = (interaction.customId || "").split(":");
    const rosterName = parts[2] ? decodeURIComponent(parts[2]) : null;
    const charNameEncoded = parts[3] || parts[2] || "";
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
        const found = findCharacterInUser(
          userDoc,
          characterName,
          parts[3] ? rosterName : null
        );
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
    if (sub === "add") {
      // Sub-routing by `action`: single → one specific char (requires
      // `character` field), all → every char in the roster (no character
      // field needed). Default to "single" if action is missing for
      // backward-compat with old test mocks that don't supply it.
      const action =
        interaction.options.getString("action", false) || "single";
      if (action === "all") return handleAddAll(interaction);
      return handleAddSingle(interaction);
    }
    if (sub === "remove") return handleRemove(interaction);
    if (sub === "clear") return handleClear(interaction);
    if (sub === "shared-add") return handleSharedAdd(interaction);
    if (sub === "shared-remove") return handleSharedRemove(interaction);
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: "Subcommand không hợp lệ",
          description: `Subcommand \`${sub}\` Artist không nhận được. Cho phép: \`add\` · \`remove\` · \`clear\` · \`shared-add\` · \`shared-remove\`.`,
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
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  generateTaskId,
  findCharacterInUser,
  findAccountInUser,
  countByReset,
  ensureSideTasks,
  ensureSharedTasks,
};
