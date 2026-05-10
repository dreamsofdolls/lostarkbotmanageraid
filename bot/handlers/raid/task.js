"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../../utils/raid/common/autocomplete");
const {
  getAccessibleAccounts,
  canEditAccount,
} = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
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
} = require("../../utils/raid/tasks/shared-tasks");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  SHARED_TASK_PRESET_ORDER,
  generateTaskId,
  normalizeName,
  sharedTaskHasPreset,
  isDuplicateSharedTask,
  sharedPresetLabel,
  formatSharedResetDetail,
  getCharacterDisplayName,
  findCharacterInUser,
  findAccountInUser,
  resolveTaskWriteTargetFromAccessible,
  ensureSideTasks,
  countByReset,
} = require("../../utils/raid/tasks/side-tasks");

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

  // Resolve the discordId whose User doc the side-task write should
  // mutate. When `rosterName` matches a roster shared to the executor
  // via /raid-share grant, the helper returns the OWNER's discordId
  // and a `viaShare` marker so the saveWithRetry closure naturally
  // loads the right document. View-level shares come back with
  // `canEdit: false` so callers can short-circuit before the retry
  // and surface a permission embed.
  //
  // Returns either:
  //   { discordId, viaShare: false }  (own roster, or no rosterName)
  //   { discordId, viaShare: true, ownerLabel, accessLevel, canEdit }
  async function resolveTaskWriteTarget(executorId, rosterName) {
    if (!rosterName) {
      return { discordId: executorId, viaShare: false };
    }
    try {
      const ownDoc = await loadUserForAutocomplete(executorId);
      if (findAccountInUser(ownDoc, rosterName)) {
        return { discordId: executorId, viaShare: false };
      }
    } catch (err) {
      console.warn("[raid-task] own roster lookup failed:", err?.message || err);
    }
    let accessible = [];
    try {
      accessible = await getAccessibleAccounts(executorId);
    } catch (err) {
      console.warn("[raid-task] getAccessibleAccounts failed:", err?.message || err);
      return { discordId: executorId, viaShare: false };
    }
    return resolveTaskWriteTargetFromAccessible(executorId, rosterName, accessible);
  }

  async function loadUserDocForRosterAutocomplete(executorId, rosterName) {
    if (!rosterName) {
      return loadUserForAutocomplete(executorId);
    }
    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare) {
      const ownerDoc = await loadUserForAutocomplete(writeTarget.discordId);
      if (ownerDoc && Array.isArray(ownerDoc.accounts)) {
        return ownerDoc;
      }
    }
    return loadUserForAutocomplete(executorId);
  }

  // User-facing rejection embed when a viewer with `permission:view`
  // share tries to write through a side-task path. Centralized so the
  // 7+ write handlers reject identically. `lang` is the executor's locale -
  // the embed is shown ephemerally to whoever ran the slash command.
  function buildViewOnlyShareEmbed(target, lang) {
    return buildNoticeEmbed(EmbedBuilder, {
      type: "error",
      title: t("raid-task.shareViewOnly.title", lang),
      description: t("raid-task.shareViewOnly.description", lang, {
        owner: target.ownerLabel || "(unknown)",
      }),
    });
  }

  async function autocompleteRoster(interaction, focused) {
    const executorId = interaction.user.id;
    // Resolve executor's locale once per autocomplete tick so every
    // choice category (own / shared) renders in their language. The
    // i18n cache absorbs the per-keystroke fan-out cost.
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const charsWord = (n) =>
      t(
        n === 1 ? "raid-task.autocomplete.charsSingular" : "raid-task.autocomplete.charsPlural",
        lang,
      );
    const taskSuffixFor = (n) =>
      n > 0 ? t("raid-task.autocomplete.taskSuffix", lang, { n }) : "";
    const userDoc = await loadUserForAutocomplete(executorId);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = matches.map((a) => {
      const chars = Array.isArray(a.characters) ? a.characters : [];
      const taskTotal = chars.reduce(
        (sum, c) => sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
        0
      );
      const label = t("raid-task.autocomplete.ownChoice", lang, {
        name: a.accountName,
        charCount: chars.length,
        charsWord: charsWord(chars.length),
        taskSuffix: taskSuffixFor(taskTotal),
      });
      return truncateChoice(label, a.accountName);
    });

    // Append rosters shared to executor via /raid-share grant. View-
    // level shares get a `· 👁️ view` tag so the executor sees they
    // cannot add/remove side tasks even if the roster is pickable
    // (write handlers will reject with the view-only embed).
    const target = focused.value ? focused.value.toLowerCase() : "";
    let shareChoices = [];
    try {
      const accessible = await getAccessibleAccounts(executorId);
      shareChoices = accessible
        .filter(
          (entry) =>
            !entry.isOwn &&
            (!target || (entry.accountName || "").toLowerCase().includes(target)),
        )
        .map((entry) => {
          const chars = Array.isArray(entry.account?.characters)
            ? entry.account.characters
            : [];
          const taskTotal = chars.reduce(
            (sum, c) => sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
            0,
          );
          const accessTag =
            entry.accessLevel === "view"
              ? t("raid-task.autocomplete.sharedAccessTagView", lang, {
                  viewLabel: t("share.accessLevel.view", lang),
                })
              : "";
          const label = t("raid-task.autocomplete.sharedChoice", lang, {
            name: entry.accountName,
            charCount: chars.length,
            charsWord: charsWord(chars.length),
            taskSuffix: taskSuffixFor(taskTotal),
            owner: entry.ownerLabel,
            accessTag,
          });
          return truncateChoice(label, entry.accountName);
        });
    } catch (err) {
      console.warn(
        "[raid-task autocomplete] getAccessibleAccounts failed:",
        err?.message || err,
      );
    }

    const merged = [...choices, ...shareChoices].slice(0, 25);
    await interaction.respond(merged).catch(() => {});
  }

  async function autocompleteCharacter(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const userDoc = await loadUserDocForRosterAutocomplete(
      interaction.user.id,
      rosterInput,
    );
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: rosterInput || null,
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
    const userDoc = await loadUserDocForRosterAutocomplete(discordId, rosterInput);
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
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const userDoc = await loadUserDocForRosterAutocomplete(discordId, rosterInput);
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
        const display = getSharedTaskDisplay(task, now, lang);
        return truncateChoice(
          `${display.emoji} ${display.name} · ${display.optionStatus || display.status}`,
          task.taskId
        );
    });
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteSharedPreset(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const userDoc = rosterInput
      ? await loadUserDocForRosterAutocomplete(interaction.user.id, rosterInput)
      : await loadUserForAutocomplete(interaction.user.id);
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
          status = t("raid-task.autocomplete.sharedPresetCustom", lang);
        } else if (selectedAccount) {
          status = sharedTaskHasPreset(selectedAccount, preset.preset, now)
            ? t("raid-task.autocomplete.sharedPresetAdded", lang)
            : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
        } else if (accounts.length > 0) {
          const count = accounts.filter((account) =>
            sharedTaskHasPreset(account, preset.preset, now)
          ).length;
          status = count > 0
            ? t("raid-task.autocomplete.sharedPresetAddedCount", lang, {
                n: count,
                total: accounts.length,
              })
            : t("raid-task.autocomplete.sharedPresetNotAdded", lang);
        } else {
          status = t("raid-task.autocomplete.sharedPresetNoRoster", lang);
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
    const executorId = interaction.user.id;
    // Executor's locale - the slash invoker IS the only viewer of every
    // ephemeral reply on /raid-task add, so this lang threads through every
    // notice + success embed without any clicker-vs-owner split.
    const lang = await getUserLanguage(executorId, { UserModel: User });
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
            title: t("raid-task.common.missingCharacterTitle", lang),
            description: t("raid-task.common.missingCharacterDescription", lang),
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
            title: t("raid-task.common.invalidTaskNameTitle", lang),
            description: t("raid-task.common.invalidTaskNameDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.reply({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-write executor=${executorId} owner=${discordId} cmd=add-single roster=${rosterName}`,
      );
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
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.addFailedDescription", lang),
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
            title: t("raid-task.common.noRosterTitle", lang),
            description: t("raid-task.common.noRosterDescription", lang),
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
            title: t("raid-task.common.noCharacterTitle", lang),
            description: t("raid-task.common.noCharacterDescription", lang, {
              characterName,
            }),
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
            title: t("raid-task.add.capReachedTitle", lang),
            description: t("raid-task.add.capReachedDescription", lang, {
              characterName: resolvedCharName,
              cap,
              reset,
              dailyCount,
              weeklyCount,
              capDaily: TASK_CAP_DAILY,
              capWeekly: TASK_CAP_WEEKLY,
            }),
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
            title: t("raid-task.add.duplicateTitle", lang),
            description: t("raid-task.add.duplicateDescription", lang, {
              characterName: resolvedCharName,
              taskName,
              reset,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cycleLabel =
      reset === "daily"
        ? t("raid-task.add.cycleDailyLabel", lang)
        : t("raid-task.add.cycleWeeklyLabel", lang);
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: t("raid-task.add.successTitle", lang),
          description: t("raid-task.add.successDescription", lang, {
            characterName: resolvedCharName,
            taskName,
            cycleLabel,
            remainDaily: TASK_CAP_DAILY - dailyCount,
            remainWeekly: TASK_CAP_WEEKLY - weeklyCount,
          }),
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
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const taskName = interaction.options.getString("name", true).trim();
    const reset = interaction.options.getString("reset", true);

    if (!taskName) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-task.common.invalidTaskNameTitle", lang),
            description: t("raid-task.common.invalidTaskNameDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.reply({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-write executor=${executorId} owner=${discordId} cmd=add-all roster=${rosterName}`,
      );
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
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.addAllFailedDescription", lang),
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
            title: t("raid-task.common.noRosterTitle", lang),
            description: t("raid-task.common.noRosterDescription", lang),
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
            title: t("raid-task.common.rosterNotFoundTitle", lang),
            description: t("raid-task.common.rosterNotFoundDescription", lang, {
              rosterName,
            }),
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
            title: t("raid-task.addAll.emptyRosterTitle", lang),
            description: t("raid-task.addAll.emptyRosterDescription", lang, {
              rosterName: resolvedRosterName,
            }),
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
            title: t("raid-task.addAll.noMatchTitle", lang),
            description: t("raid-task.addAll.noMatchDescription", lang, {
              rosterName: resolvedRosterName,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Build the success embed body. The locale `successDescription`
    // template carries the roster/task/cycle/added prefix; the dup +
    // cap skipped sections are appended via the per-locale
    // skippedHeader/skippedLine templates so the wording stays in
    // the executor's language.
    const cycleLabel =
      reset === "daily"
        ? t("raid-task.add.cycleDailyLabel", lang)
        : t("raid-task.add.cycleWeeklyLabel", lang);
    const totalChars = added.length + skippedCap.length + skippedDup.length;
    const addedNames =
      `${added.length}/${totalChars}` +
      (added.length > 0 ? `\n> ${added.join(", ")}` : "");
    const skippedSectionParts = [];
    if (skippedDup.length > 0) {
      const reasonDup = t("raid-task.addAll.skippedReasonDup", lang);
      skippedSectionParts.push(
        "\n\n" +
          t("raid-task.addAll.skippedHeader", lang, { count: skippedDup.length }) +
          "\n" +
          skippedDup
            .map((charName) =>
              t("raid-task.addAll.skippedLine", lang, { charName, reason: reasonDup }),
            )
            .join("\n"),
      );
    }
    if (skippedCap.length > 0) {
      const cap = reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
      const reasonCap = t("raid-task.addAll.skippedReasonCap", lang, { cap, reset });
      skippedSectionParts.push(
        "\n\n" +
          t("raid-task.addAll.skippedHeader", lang, { count: skippedCap.length }) +
          "\n" +
          skippedCap
            .map((charName) =>
              t("raid-task.addAll.skippedLine", lang, { charName, reason: reasonCap }),
            )
            .join("\n"),
      );
    }
    const skippedSection = skippedSectionParts.join("");

    const type = added.length > 0 ? "success" : "info";
    const title =
      added.length > 0
        ? t("raid-task.addAll.successTitle", lang)
        : t("raid-task.addAll.noMatchTitle", lang);
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type,
          title,
          description: t("raid-task.addAll.successDescription", lang, {
            rosterName: resolvedRosterName,
            taskName,
            cycleLabel,
            addedNames,
            skippedSection,
          }),
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
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
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
            title: t("raid-task.sharedAdd.invalidPresetTitle", lang),
            description: t("raid-task.sharedAdd.invalidPresetDescription", lang),
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
            title: t("raid-task.sharedAdd.customNeedsNameTitle", lang),
            description: t("raid-task.sharedAdd.customNeedsNameDescription", lang),
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
            title: t("raid-task.sharedAdd.invalidExpiryTitle", lang),
            description: t("raid-task.sharedAdd.invalidExpiryDescription", lang),
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
            title: t("raid-task.sharedAdd.pastExpiryTitle", lang),
            description: t("raid-task.sharedAdd.pastExpiryDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Share-aware target resolution. Only applies when the operation
    // targets a single roster - `applyAllRosters: true` operates on
    // executor's OWN rosters only (shared rosters are guest passes,
    // not full ownership, so bulk-applying tasks across them would
    // overstep the share contract).
    let writeTarget = { discordId: executorId, viaShare: false };
    if (!applyAllRosters) {
      writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
      if (writeTarget.viaShare && !writeTarget.canEdit) {
        await interaction.reply({
          embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (writeTarget.viaShare) {
        console.log(
          `[raid-task] share-write executor=${executorId} owner=${writeTarget.discordId} cmd=shared-add roster=${rosterName}`,
        );
      }
    }
    const discordId = writeTarget.discordId;

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
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.sharedAddFailedDescription", lang),
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
            title: t("raid-task.common.rosterNotFoundTitle", lang),
            description: t("raid-task.common.rosterNotFoundDescription", lang, {
              rosterName,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (outcome === "none-added") {
      // Build skippedSummary block from per-locale templates so the
      // dup vs cap reasons read in the executor's language.
      const summaryParts = [];
      if (skippedDup.length > 0) {
        summaryParts.push(
          t("raid-task.sharedAdd.skippedSummaryDup", lang, {
            names: skippedDup.join(", "),
          }),
        );
      }
      if (skippedCap.length > 0) {
        summaryParts.push(
          t("raid-task.sharedAdd.skippedSummaryCap", lang, {
            names: skippedCap.join(", "),
          }),
        );
      }
      const skippedSummary = summaryParts.length > 0 ? summaryParts.join("\n") : "";
      // Compose the embed body manually because the locale's
      // `noNewRosterDescription` is a tighter template; the handler
      // here surfaces preset + roster-count + skipped info in one
      // compact block. Each labeled line uses a per-locale template
      // so wording stays in the executor's language.
      const lines = [
        t("raid-task.sharedAdd.noNewRosterTaskLine", lang, {
          taskName: `${preset.emoji} ${taskName}`,
        }),
        t("raid-task.sharedAdd.noNewRosterTypeLine", lang, {
          presetLabel: preset.label,
        }),
        t("raid-task.sharedAdd.noNewRosterRostersChecked", lang, { count: targetRosterCount }),
      ];
      if (skippedSummary) lines.push(skippedSummary);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-task.sharedAdd.noNewRosterTitle", lang),
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
            title: t("raid-task.sharedAdd.capReachedTitle", lang),
            description: t("raid-task.sharedAdd.capReachedDescriptionSingle", lang, {
              rosterName: resolvedRosterName,
              count: countForReset,
              cap,
              resetLabel: formatSharedResetDetail(reset, { t, lang }),
            }),
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
            title: t("raid-task.sharedAdd.duplicateTitle", lang),
            description:
              preset.kind === "scheduled"
                ? t("raid-task.sharedAdd.duplicateScheduledDescription", lang, {
                    rosterName: resolvedRosterName,
                    presetLabel: preset.label,
                  })
                : t("raid-task.sharedAdd.duplicateNamedDescription", lang, {
                    rosterName: resolvedRosterName,
                    taskName,
                    resetLabel: formatSharedResetDetail(reset, { t, lang }),
                  }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Success path. The locale provides single + multi templates that
    // carry roster/task/type/expiry info. Skipped sections (dup/cap)
    // only appear in apply-all-rosters mode and use the dedicated
    // skippedSection* templates.
    const expirySuffix = expiresAt
      ? t("raid-task.sharedAdd.expirySuffix", lang, {
          date: `<t:${Math.floor(expiresAt / 1000)}:D>`,
        })
      : "";
    const presetLabel = `${preset.emoji} ${preset.label}`;
    let descriptionText;
    if (applyAllRosters) {
      const skippedSectionParts = [];
      if (skippedDup.length > 0) {
        skippedSectionParts.push(
          t("raid-task.sharedAdd.skippedSectionDup", lang, {
            names: skippedDup.join(", "),
          }),
        );
      }
      if (skippedCap.length > 0) {
        skippedSectionParts.push(
          t("raid-task.sharedAdd.skippedSectionCap", lang, {
            names: skippedCap.join(", "),
          }),
        );
      }
      descriptionText = t("raid-task.sharedAdd.successDescriptionMulti", lang, {
        presetLabel,
        expirySuffix,
        addedCount: addedRosters.length,
        addedNames: addedRosters.join(", "),
        skippedSection: skippedSectionParts.join(""),
      });
    } else {
      descriptionText = t("raid-task.sharedAdd.successDescriptionSingle", lang, {
        rosterName: resolvedRosterName,
        taskName: `${preset.emoji} ${taskName}`,
        presetLabel,
        expirySuffix,
      });
    }

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "success",
          title: t("raid-task.sharedAdd.successTitle", lang),
          description: descriptionText,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleSharedRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const taskId = interaction.options.getString("task", true);

    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.reply({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-write executor=${executorId} owner=${discordId} cmd=shared-remove roster=${rosterName}`,
      );
    }

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
        removedTaskName = sharedTasks[idx]?.name || t("raid-task.unnamedTaskFallback", lang);
        sharedTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task shared-remove] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.sharedRemoveFailedDescription", lang),
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
            title: t("raid-task.common.rosterNotFoundTitle", lang),
            description: t("raid-task.common.rosterNotFoundDescription", lang, {
              rosterName,
            }),
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
            title: t("raid-task.sharedRemove.noTaskTitle", lang),
            description: t("raid-task.sharedRemove.noTaskDescription", lang),
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
          title: t("raid-task.sharedRemove.successTitle", lang),
          description: t("raid-task.sharedRemove.successDescription", lang, {
            rosterName: resolvedRosterName,
            taskName: removedTaskName,
          }),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);
    const taskId = interaction.options.getString("task", true);

    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.reply({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-write executor=${executorId} owner=${discordId} cmd=remove roster=${rosterName}`,
      );
    }

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
        removedTaskName = sideTasks[idx]?.name || t("raid-task.unnamedTaskFallback", lang);
        sideTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task remove] save failed:", error?.message || error);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.removeFailedDescription", lang),
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
            title: t("raid-task.common.noCharacterTitle", lang),
            description: t("raid-task.common.noCharacterDescription", lang, {
              characterName,
            }),
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
            title: t("raid-task.remove.noTaskTitle", lang),
            description: t("raid-task.remove.noTaskDescription", lang),
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
          title: t("raid-task.remove.successTitle", lang),
          description: t("raid-task.remove.successDescription", lang, {
            characterName: resolvedCharName,
            taskName: removedTaskName,
          }),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleClear(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);

    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.reply({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-preview executor=${executorId} owner=${discordId} cmd=clear roster=${rosterName}`,
      );
    }

    const userDoc = await User.findOne({ discordId }).lean();
    const found = userDoc
      ? findCharacterInUser(userDoc, characterName, rosterName)
      : null;
    if (!found) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-task.common.noCharacterTitle", lang),
            description: t("raid-task.common.noCharacterDescription", lang, {
              characterName,
            }),
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
            title: t("raid-task.clear.nothingTitle", lang),
            description: t("raid-task.clear.nothingDescription", lang, {
              characterName: resolvedCharName,
            }),
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
        .setLabel(t("raid-task.clear.confirmButtonLabel", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("raid-task:clear-cancel")
        .setLabel(t("raid-task.clear.cancelButtonLabel", lang))
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t("raid-task.clear.confirmTitle", lang),
          description: t("raid-task.clear.confirmDescription", lang, {
            taskCount: sideTasks.length,
            characterName: resolvedCharName,
            dailyCount,
            weeklyCount,
          }),
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
    const executorId = interaction.user.id;
    // Resolve clicker's locale. The /raid-task clear reply is ephemeral
    // so only the original invoker can click this button - clicker ===
    // session opener in practice, but resolving via the button-clicker
    // discordId is the safer pattern.
    const lang = await getUserLanguage(executorId, { UserModel: User });

    // Share-aware target resolution. The button click respects whatever
    // share the user picked when they originally ran /raid-task clear -
    // a re-resolve here keeps the write routing to the same owner doc
    // even if the share changed mid-flight.
    const writeTarget = parts[3]
      ? await resolveTaskWriteTarget(executorId, rosterName)
      : { discordId: executorId, viaShare: false };
    if (writeTarget.viaShare && !writeTarget.canEdit) {
      await interaction.update({
        embeds: [buildViewOnlyShareEmbed(writeTarget, lang)],
        components: [],
      });
      return;
    }
    const discordId = writeTarget.discordId;
    if (writeTarget.viaShare) {
      console.log(
        `[raid-task] share-write executor=${executorId} owner=${discordId} cmd=clear-confirm roster=${rosterName}`,
      );
    }

    let outcome = "cleared";
    let resolvedCharName = characterName;
    let removedCount = 0;
    // Capture daily/weekly counts BEFORE the splice so the success
    // embed (locale `clear.successDescription` interpolates both)
    // can render the breakdown the user just deleted.
    let removedDailyCount = 0;
    let removedWeeklyCount = 0;

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
        removedDailyCount = countByReset(sideTasks, "daily");
        removedWeeklyCount = countByReset(sideTasks, "weekly");
        found.character.sideTasks = [];
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task clear] save failed:", error?.message || error);
      await interaction.update({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-task.save.addFailedTitle", lang),
            description: t("raid-task.save.clearFailedDescription", lang),
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
            title: t("raid-task.clear.confirmFailedCharacterTitle", lang),
            description: t("raid-task.clear.confirmFailedCharacterDescription", lang),
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
          title: t("raid-task.clear.successTitle", lang),
          description: t("raid-task.clear.successDescription", lang, {
            taskCount: removedCount,
            characterName: resolvedCharName,
            dailyCount: removedDailyCount,
            weeklyCount: removedWeeklyCount,
          }),
        }),
      ],
      components: [],
    }).catch(() => {});
  }

  async function handleClearCancelButton(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await interaction.update({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "muted",
          title: t("raid-task.clear.cancelledTitle", lang),
          description: t("raid-task.clear.cancelledDescription", lang),
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
    // Fallback path: unknown subcommand. Resolve lang lazily here since
    // we never reach this branch on the happy path.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t("raid-task.invalidSubcommandTitle", lang),
          description: t("raid-task.invalidSubcommandDescription", lang, { sub }),
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
  resolveTaskWriteTargetFromAccessible,
  countByReset,
  ensureSideTasks,
  ensureSharedTasks,
};
