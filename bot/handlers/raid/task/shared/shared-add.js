"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  SCHEDULED_RESET,
  SHARED_TASK_PRESETS,
  getSharedTaskPreset,
  ensureSharedTasks,
  countSharedTasksByReset,
  sharedTaskCapForReset,
  parseSharedTaskExpiresAt,
} = require("../../../../utils/raid/tasks/shared-tasks");
const {
  generateTaskId,
  isDuplicateSharedTask,
  findAccountInUser,
  formatSharedResetDetail,
} = require("../../../../utils/raid/tasks/side-tasks");

function resolveSharedTaskReset(preset, requestedReset) {
  if (preset.kind === "scheduled") return SCHEDULED_RESET;
  if (requestedReset === "daily" || requestedReset === "weekly") {
    return requestedReset;
  }
  return preset.reset || "weekly";
}

function readSharedAddRequest(interaction) {
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

  return {
    applyAllRosters,
    expiresAt,
    preset,
    presetKey,
    reset,
    rosterName,
    taskName,
  };
}

function buildValidationNotice(request, lang) {
  const checks = [
    {
      failed: !SHARED_TASK_PRESETS[request.presetKey],
      titleKey: "raid-task.sharedAdd.invalidPresetTitle",
      descriptionKey: "raid-task.sharedAdd.invalidPresetDescription",
    },
    {
      failed: !request.taskName,
      titleKey: "raid-task.sharedAdd.customNeedsNameTitle",
      descriptionKey: "raid-task.sharedAdd.customNeedsNameDescription",
    },
    {
      failed: Number.isNaN(request.expiresAt),
      titleKey: "raid-task.sharedAdd.invalidExpiryTitle",
      descriptionKey: "raid-task.sharedAdd.invalidExpiryDescription",
    },
    {
      failed: request.expiresAt && request.expiresAt < Date.now(),
      titleKey: "raid-task.sharedAdd.pastExpiryTitle",
      descriptionKey: "raid-task.sharedAdd.pastExpiryDescription",
    },
  ];
  const match = checks.find((check) => check.failed);
  if (!match) return null;
  return {
    type: "warn",
    title: t(match.titleKey, lang),
    description: t(match.descriptionKey, lang),
  };
}

function createSharedAddResult(rosterName) {
  return {
    outcome: "added",
    resolvedRosterName: rosterName,
    countForReset: 0,
    targetRosterCount: 0,
    addedRosters: [],
    skippedDup: [],
    skippedCap: [],
  };
}

function resolveTargetAccountsForSharedAdd(userDoc, request, result) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    result.outcome = "no-roster";
    return [];
  }

  const accounts = request.applyAllRosters
    ? userDoc.accounts.filter((account) => account?.accountName)
    : [findAccountInUser(userDoc, request.rosterName)].filter(Boolean);
  if (accounts.length === 0) {
    result.outcome = "no-roster-match";
    return [];
  }

  result.targetRosterCount = accounts.length;
  result.resolvedRosterName = accounts[0]?.accountName || request.rosterName;
  return accounts;
}

function cycleStartForReset(reset, { dailyResetStartMs, weekResetStartMs }) {
  if (reset === "daily") return dailyResetStartMs();
  if (reset === "weekly") return weekResetStartMs();
  return 0;
}

function buildSharedTaskRecord(request, now, deps) {
  return {
    taskId: generateTaskId(),
    preset: request.preset.preset,
    name: request.taskName,
    reset: request.reset,
    completed: false,
    completedAt: null,
    completedForKey: "",
    lastResetAt: cycleStartForReset(request.reset, deps),
    createdAt: now,
    expiresAt: request.expiresAt,
    archivedAt: null,
    timezone: request.preset.timeZone || "America/Los_Angeles",
  };
}

function applySharedAddToAccount(account, request, result, deps, now) {
  const sharedTasks = ensureSharedTasks(account);
  const cap = sharedTaskCapForReset(request.reset);
  const currentCount = countSharedTasksByReset(sharedTasks, request.reset, now);
  if (currentCount >= cap) {
    result.countForReset = currentCount;
    result.skippedCap.push(`${account.accountName} (${currentCount}/${cap})`);
    return "cap-reached";
  }

  if (isDuplicateSharedTask(sharedTasks, request.preset, request.taskName, request.reset, now)) {
    result.skippedDup.push(account.accountName);
    return "duplicate";
  }

  sharedTasks.push(buildSharedTaskRecord(request, now, deps));
  result.countForReset = currentCount + 1;
  result.addedRosters.push(account.accountName);
  return "added";
}

function applySharedAddToUserDoc(userDoc, request, result, deps, now) {
  const targetAccounts = resolveTargetAccountsForSharedAdd(userDoc, request, result);
  for (const account of targetAccounts) {
    const accountOutcome = applySharedAddToAccount(account, request, result, deps, now);
    if (!request.applyAllRosters && accountOutcome !== "added") {
      result.outcome = accountOutcome;
      return;
    }
  }

  if (request.applyAllRosters && result.addedRosters.length === 0) {
    result.outcome = "none-added";
  }
}

function buildSkippedSummary(result, lang) {
  const summaryParts = [];
  if (result.skippedDup.length > 0) {
    summaryParts.push(
      t("raid-task.sharedAdd.skippedSummaryDup", lang, {
        names: result.skippedDup.join(", "),
      }),
    );
  }
  if (result.skippedCap.length > 0) {
    summaryParts.push(
      t("raid-task.sharedAdd.skippedSummaryCap", lang, {
        names: result.skippedCap.join(", "),
      }),
    );
  }
  return summaryParts.join("\n");
}

function buildSkippedSection(result, lang) {
  const skippedSectionParts = [];
  if (result.skippedDup.length > 0) {
    skippedSectionParts.push(
      t("raid-task.sharedAdd.skippedSectionDup", lang, {
        names: result.skippedDup.join(", "),
      }),
    );
  }
  if (result.skippedCap.length > 0) {
    skippedSectionParts.push(
      t("raid-task.sharedAdd.skippedSectionCap", lang, {
        names: result.skippedCap.join(", "),
      }),
    );
  }
  return skippedSectionParts.join("");
}

function buildSharedAddSuccessDescription(result, request, lang) {
  const expirySuffix = request.expiresAt
    ? t("raid-task.sharedAdd.expirySuffix", lang, {
        date: `<t:${Math.floor(request.expiresAt / 1000)}:D>`,
      })
    : "";
  const presetLabel = `${request.preset.emoji} ${request.preset.label}`;
  if (request.applyAllRosters) {
    return t("raid-task.sharedAdd.successDescriptionMulti", lang, {
      presetLabel,
      expirySuffix,
      addedCount: result.addedRosters.length,
      addedNames: result.addedRosters.join(", "),
      skippedSection: buildSkippedSection(result, lang),
    });
  }
  return t("raid-task.sharedAdd.successDescriptionSingle", lang, {
    rosterName: result.resolvedRosterName,
    taskName: `${request.preset.emoji} ${request.taskName}`,
    presetLabel,
    expirySuffix,
  });
}

function buildNoNewRosterNotice(result, request, lang) {
  const skippedSummary = buildSkippedSummary(result, lang);
  const lines = [
    t("raid-task.sharedAdd.noNewRosterTaskLine", lang, {
      taskName: `${request.preset.emoji} ${request.taskName}`,
    }),
    t("raid-task.sharedAdd.noNewRosterTypeLine", lang, {
      presetLabel: request.preset.label,
    }),
    t("raid-task.sharedAdd.noNewRosterRostersChecked", lang, {
      count: result.targetRosterCount,
    }),
  ];
  if (skippedSummary) lines.push(skippedSummary);
  return {
    type: "info",
    title: t("raid-task.sharedAdd.noNewRosterTitle", lang),
    description: lines.join("\n"),
  };
}

function buildDuplicateNotice(result, request, lang) {
  const description = request.preset.kind === "scheduled"
    ? t("raid-task.sharedAdd.duplicateScheduledDescription", lang, {
        rosterName: result.resolvedRosterName,
        presetLabel: request.preset.label,
      })
    : t("raid-task.sharedAdd.duplicateNamedDescription", lang, {
        rosterName: result.resolvedRosterName,
        taskName: request.taskName,
        resetLabel: formatSharedResetDetail(request.reset, { t, lang }),
      });

  return {
    type: "info",
    title: t("raid-task.sharedAdd.duplicateTitle", lang),
    description,
  };
}

const SHARED_ADD_NOTICE_BUILDERS = {
  "no-roster": ({ request, lang }) => ({
    type: "warn",
    title: t("raid-task.common.rosterNotFoundTitle", lang),
    description: t("raid-task.common.rosterNotFoundDescription", lang, {
      rosterName: request.rosterName,
    }),
  }),
  "no-roster-match": ({ request, lang }) => ({
    type: "warn",
    title: t("raid-task.common.rosterNotFoundTitle", lang),
    description: t("raid-task.common.rosterNotFoundDescription", lang, {
      rosterName: request.rosterName,
    }),
  }),
  "none-added": ({ result, request, lang }) => buildNoNewRosterNotice(result, request, lang),
  "cap-reached": ({ result, request, lang }) => ({
    type: "warn",
    title: t("raid-task.sharedAdd.capReachedTitle", lang),
    description: t("raid-task.sharedAdd.capReachedDescriptionSingle", lang, {
      rosterName: result.resolvedRosterName,
      count: result.countForReset,
      cap: sharedTaskCapForReset(request.reset),
      resetLabel: formatSharedResetDetail(request.reset, { t, lang }),
    }),
  }),
  duplicate: ({ result, request, lang }) => buildDuplicateNotice(result, request, lang),
  added: ({ result, request, lang }) => ({
    type: "success",
    title: t("raid-task.sharedAdd.successTitle", lang),
    description: buildSharedAddSuccessDescription(result, request, lang),
  }),
};

function buildSharedAddNotice(result, request, lang) {
  const builder = SHARED_ADD_NOTICE_BUILDERS[result.outcome] || SHARED_ADD_NOTICE_BUILDERS.added;
  return builder({ result, request, lang });
}

function buildSharedAddSaveFailedNotice(lang) {
  return {
    type: "error",
    title: t("raid-task.save.addFailedTitle", lang),
    description: t("raid-task.save.sharedAddFailedDescription", lang),
  };
}

function createSharedAddHandler({
  User,
  saveWithRetry,
  dailyResetStartMs,
  weekResetStartMs,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  return async function handleSharedAdd(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const request = readSharedAddRequest(interaction);
    const validationNotice = buildValidationNotice(request, lang);
    if (validationNotice) {
      await replyTaskNotice(interaction, validationNotice);
      return;
    }

    let writeTarget = { discordId: executorId, viaShare: false };
    if (!request.applyAllRosters) {
      const access = await resolveEditableTaskWriteAccess({
        executorId,
        rosterName: request.rosterName,
        commandName: "shared-add",
        resolveTaskWriteTarget,
        denyViewOnly: (target) => replyViewOnlyShareNotice(interaction, target, lang),
      });
      if (!access.ok) return;
      writeTarget = access.writeTarget;
    }

    const result = createSharedAddResult(request.rosterName);
    const now = Date.now();
    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId: writeTarget.discordId });
        applySharedAddToUserDoc(
          userDoc,
          request,
          result,
          { dailyResetStartMs, weekResetStartMs },
          now
        );
        if (result.addedRosters.length > 0) {
          await userDoc.save();
        }
      });
    } catch (error) {
      console.error("[raid-task shared-add] save failed:", error?.message || error);
      await replyTaskNotice(interaction, buildSharedAddSaveFailedNotice(lang));
      return;
    }

    await replyTaskNotice(interaction, buildSharedAddNotice(result, request, lang));
  };
}

module.exports = {
  createSharedAddHandler,
  resolveSharedTaskReset,
};
