/**
 * handlers/raid/task.js
 * /raid-task: per-character + roster-level side tasks (Una dailies,
 * Chaos Gate, Field Boss, custom presets). Subcommands: add / remove
 * / clear / shared-add / shared-remove. Auto-reset 17:00 VN daily,
 * Wed 17:00 weekly; scheduled presets follow UTC-4 windows. Toggle
 * complete via the /raid-status side-tasks dropdown.
 */

"use strict";

const { getAccessibleAccounts } = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
const { createRaidTaskAutocompleteHandlers } = require("./task/autocomplete");
const { createRaidTaskNoticeHelpers } = require("./task/notices");
const { createRaidTaskWriteTargetResolver } = require("./task/write-target");
const { resolveEditableTaskWriteAccess } = require("./task/write-access");
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
} = require("../../utils/raid/tasks/shared-tasks");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
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

/**
 * Build the /raid-task command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   MessageFlags, Mongoose User model, saveWithRetry, task helpers
 *   from utils/raid/tasks/*, access-control + roster-owner-resolver
 *   for shared rosters · see destructure block).
 * @returns {{
 *   handleRaidTaskCommand: Function,
 *   handleRaidTaskAutocomplete: Function,
 *   handleRaidTaskButton: Function,
 * }} handlers wired into commands.js dispatch + autocomplete + button-
 *   route maps
 */
function createRaidTaskCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User,
    saveWithRetry,
    loadUserForAutocomplete,
    dailyResetStartMs,
    weekResetStartMs,
  } = deps;

  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete,
    getAccessibleAccounts,
  });
  const {
    replyTaskNotice,
    updateTaskNotice,
    replyViewOnlyShareNotice,
    viewOnlyShareNotice,
  } = createRaidTaskNoticeHelpers({ EmbedBuilder });

  const { handleRaidTaskAutocomplete } = createRaidTaskAutocompleteHandlers({
    User,
    loadUserForAutocomplete,
    resolveTaskWriteTarget,
  });

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
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.missingCharacterTitle", lang),
        description: t("raid-task.common.missingCharacterDescription", lang),
      });
      return;
    }

    if (!taskName) {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.invalidTaskNameTitle", lang),
        description: t("raid-task.common.invalidTaskNameDescription", lang),
      });
      return;
    }

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "add-single",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

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
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.addFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noRosterTitle", lang),
        description: t("raid-task.common.noRosterDescription", lang),
      });
      return;
    }
    if (outcome === "no-character") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noCharacterTitle", lang),
        description: t("raid-task.common.noCharacterDescription", lang, {
          characterName,
        }),
      });
      return;
    }
    if (outcome === "cap-reached") {
      const cap = reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
      await replyTaskNotice(interaction, {
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
      });
      return;
    }
    if (outcome === "duplicate") {
      await replyTaskNotice(interaction, {
        type: "info",
        title: t("raid-task.add.duplicateTitle", lang),
        description: t("raid-task.add.duplicateDescription", lang, {
          characterName: resolvedCharName,
          taskName,
          reset,
        }),
      });
      return;
    }

    const cycleLabel =
      reset === "daily"
        ? t("raid-task.add.cycleDailyLabel", lang)
        : t("raid-task.add.cycleWeeklyLabel", lang);
    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.add.successTitle", lang),
      description: t("raid-task.add.successDescription", lang, {
        characterName: resolvedCharName,
        taskName,
        cycleLabel,
        remainDaily: TASK_CAP_DAILY - dailyCount,
        remainWeekly: TASK_CAP_WEEKLY - weeklyCount,
      }),
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
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.invalidTaskNameTitle", lang),
        description: t("raid-task.common.invalidTaskNameDescription", lang),
      });
      return;
    }

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "add-all",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

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
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.addAllFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noRosterTitle", lang),
        description: t("raid-task.common.noRosterDescription", lang),
      });
      return;
    }
    if (outcome === "no-roster-match") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.rosterNotFoundTitle", lang),
        description: t("raid-task.common.rosterNotFoundDescription", lang, {
          rosterName,
        }),
      });
      return;
    }
    if (outcome === "empty-roster") {
      await replyTaskNotice(interaction, {
        type: "info",
        title: t("raid-task.addAll.emptyRosterTitle", lang),
        description: t("raid-task.addAll.emptyRosterDescription", lang, {
          rosterName: resolvedRosterName,
        }),
      });
      return;
    }

    if (added.length === 0 && skippedCap.length === 0 && skippedDup.length === 0) {
      await replyTaskNotice(interaction, {
        type: "info",
        title: t("raid-task.addAll.noMatchTitle", lang),
        description: t("raid-task.addAll.noMatchDescription", lang, {
          rosterName: resolvedRosterName,
        }),
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
    await replyTaskNotice(interaction, {
      type,
      title,
      description: t("raid-task.addAll.successDescription", lang, {
        rosterName: resolvedRosterName,
        taskName,
        cycleLabel,
        addedNames,
        skippedSection,
      }),
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
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedAdd.invalidPresetTitle", lang),
        description: t("raid-task.sharedAdd.invalidPresetDescription", lang),
      });
      return;
    }

    if (!taskName) {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedAdd.customNeedsNameTitle", lang),
        description: t("raid-task.sharedAdd.customNeedsNameDescription", lang),
      });
      return;
    }
    if (Number.isNaN(expiresAt)) {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedAdd.invalidExpiryTitle", lang),
        description: t("raid-task.sharedAdd.invalidExpiryDescription", lang),
      });
      return;
    }
    if (expiresAt && expiresAt < Date.now()) {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedAdd.pastExpiryTitle", lang),
        description: t("raid-task.sharedAdd.pastExpiryDescription", lang),
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
      const access = await resolveEditableTaskWriteAccess({
        executorId,
        rosterName,
        commandName: "shared-add",
        resolveTaskWriteTarget,
        denyViewOnly: (target) => replyViewOnlyShareNotice(interaction, target, lang),
      });
      if (!access.ok) return;
      writeTarget = access.writeTarget;
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
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.sharedAddFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-roster-match") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.rosterNotFoundTitle", lang),
        description: t("raid-task.common.rosterNotFoundDescription", lang, {
          rosterName,
        }),
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
      await replyTaskNotice(interaction, {
        type: "info",
        title: t("raid-task.sharedAdd.noNewRosterTitle", lang),
        description: lines.join("\n"),
      });
      return;
    }
    if (outcome === "cap-reached") {
      const cap = sharedTaskCapForReset(reset);
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedAdd.capReachedTitle", lang),
        description: t("raid-task.sharedAdd.capReachedDescriptionSingle", lang, {
          rosterName: resolvedRosterName,
          count: countForReset,
          cap,
          resetLabel: formatSharedResetDetail(reset, { t, lang }),
        }),
      });
      return;
    }
    if (outcome === "duplicate") {
      await replyTaskNotice(interaction, {
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

    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.sharedAdd.successTitle", lang),
      description: descriptionText,
    });
  }

  async function handleSharedRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const taskId = interaction.options.getString("task", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "shared-remove",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

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
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.sharedRemoveFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-roster-match") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.rosterNotFoundTitle", lang),
        description: t("raid-task.common.rosterNotFoundDescription", lang, {
          rosterName,
        }),
      });
      return;
    }
    if (outcome === "task-not-found") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedRemove.noTaskTitle", lang),
        description: t("raid-task.sharedRemove.noTaskDescription", lang),
      });
      return;
    }

    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.sharedRemove.successTitle", lang),
      description: t("raid-task.sharedRemove.successDescription", lang, {
        rosterName: resolvedRosterName,
        taskName: removedTaskName,
      }),
    });
  }

  async function handleRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);
    const taskId = interaction.options.getString("task", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "remove",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

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
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.removeFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-character") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noCharacterTitle", lang),
        description: t("raid-task.common.noCharacterDescription", lang, {
          characterName,
        }),
      });
      return;
    }
    if (outcome === "task-not-found") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.remove.noTaskTitle", lang),
        description: t("raid-task.remove.noTaskDescription", lang),
      });
      return;
    }

    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.remove.successTitle", lang),
      description: t("raid-task.remove.successDescription", lang, {
        characterName: resolvedCharName,
        taskName: removedTaskName,
      }),
    });
  }

  async function handleClear(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "clear",
      logKind: "share-preview",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

    const userDoc = await User.findOne({ discordId }).lean();
    const found = userDoc
      ? findCharacterInUser(userDoc, characterName, rosterName)
      : null;
    if (!found) {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noCharacterTitle", lang),
        description: t("raid-task.common.noCharacterDescription", lang, {
          characterName,
        }),
      });
      return;
    }
    const resolvedCharName = getCharacterDisplayName(found.character);
    const sideTasks = Array.isArray(found.character.sideTasks)
      ? found.character.sideTasks
      : [];
    if (sideTasks.length === 0) {
      await replyTaskNotice(interaction, {
        type: "info",
        title: t("raid-task.clear.nothingTitle", lang),
        description: t("raid-task.clear.nothingDescription", lang, {
          characterName: resolvedCharName,
        }),
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

    await replyTaskNotice(interaction, {
      type: "warn",
      title: t("raid-task.clear.confirmTitle", lang),
      description: t("raid-task.clear.confirmDescription", lang, {
        taskCount: sideTasks.length,
        characterName: resolvedCharName,
        dailyCount,
        weeklyCount,
      }),
    }, {
      components: [confirmRow],
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
    const access = parts[3]
      ? await resolveEditableTaskWriteAccess({
          executorId,
          rosterName,
          commandName: "clear-confirm",
          resolveTaskWriteTarget,
          denyViewOnly: (writeTarget) =>
            updateTaskNotice(interaction, viewOnlyShareNotice(writeTarget, lang)),
        })
      : { ok: true, discordId: executorId };
    if (!access.ok) return;
    const discordId = access.discordId;

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
      await updateTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.clearFailedDescription", lang),
      }).catch(() => {});
      return;
    }

    if (outcome === "no-roster" || outcome === "no-character") {
      await updateTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.clear.confirmFailedCharacterTitle", lang),
        description: t("raid-task.clear.confirmFailedCharacterDescription", lang),
      }).catch(() => {});
      return;
    }

    await updateTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.clear.successTitle", lang),
      description: t("raid-task.clear.successDescription", lang, {
        taskCount: removedCount,
        characterName: resolvedCharName,
        dailyCount: removedDailyCount,
        weeklyCount: removedWeeklyCount,
      }),
    }).catch(() => {});
  }

  async function handleClearCancelButton(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await updateTaskNotice(interaction, {
      type: "muted",
      title: t("raid-task.clear.cancelledTitle", lang),
      description: t("raid-task.clear.cancelledDescription", lang),
    }).catch(() => {});
  }

  const BUTTON_ROUTES = Object.freeze([
    { prefix: "raid-task:clear-confirm:", handle: handleClearConfirmButton },
    { exact: "raid-task:clear-cancel", handle: handleClearCancelButton },
  ]);

  function findButtonRoute(customId) {
    return BUTTON_ROUTES.find((route) => {
      if (route.exact) return customId === route.exact;
      return customId.startsWith(route.prefix);
    });
  }

  async function handleRaidTaskButton(interaction) {
    const customId = interaction.customId || "";
    const route = findButtonRoute(customId);
    if (route) await route.handle(interaction);
  }

  const SUBCOMMAND_HANDLERS = Object.freeze({
    add: async (interaction) => {
      // Sub-routing by `action`: single -> one specific char (requires
      // `character` field), all -> every char in the roster (no character
      // field needed). Default to "single" if old test mocks omit it.
      const action =
        interaction.options.getString("action", false) || "single";
      if (action === "all") return handleAddAll(interaction);
      return handleAddSingle(interaction);
    },
    remove: handleRemove,
    clear: handleClear,
    "shared-add": handleSharedAdd,
    "shared-remove": handleSharedRemove,
  });

  async function handleRaidTaskCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    const handler = SUBCOMMAND_HANDLERS[sub];
    if (handler) return handler(interaction);
    // Fallback path: unknown subcommand. Resolve lang lazily here since
    // we never reach this branch on the happy path.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await replyTaskNotice(interaction, {
      type: "warn",
      title: t("raid-task.invalidSubcommandTitle", lang),
      description: t("raid-task.invalidSubcommandDescription", lang, { sub }),
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
