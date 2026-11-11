"use strict";

// tPick, not t: some titles here are variant pools; non-pool keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const { createTaskMutationHandler } = require("../write-handler");
const {
  SCHEDULED_RESET,
  SHARED_TASK_PRESETS,
  getSharedTaskPreset,
  ensureSharedTasks,
  countSharedTasksByReset,
  formatDiscordTimestamp,
  sharedTaskCapForReset,
  parseSharedTaskExpiresAt,
} = require("../../../../utils/raid/tasks/shared-tasks");
const {
  generateTaskId,
  isDuplicateSharedTask,
  findAccountInUser,
  formatSharedResetDetail,
} = require("../../../../utils/raid/tasks/side-tasks");
const { NoticeKind, buildRosterNotFoundNotice } = require("../../../../utils/raid/common/shared");
const { hasRosterAccounts } = require("../../../../utils/user-doc");

function resolveSharedTaskReset(preset, requestedReset) {
  if (preset.kind === "scheduled") return SCHEDULED_RESET;
  if (requestedReset === "daily" || requestedReset === "weekly") {
    return requestedReset;
  }
  return preset.reset || "weekly";
}

function readSharedAddRequest(interaction, lang) {
  const rosterName = interaction.options.getString("roster", true);
  const presetKey = interaction.options.getString("preset", true);
  const preset = getSharedTaskPreset(presetKey);
  const requestedReset = interaction.options.getString("reset", false);
  const reset = resolveSharedTaskReset(preset, requestedReset);
  const taskNameInput = interaction.options.getString("name", false);
  const taskName = String(taskNameInput || preset.defaultName).trim();
  const expiresRaw = interaction.options.getString("expires_at", false);
  const expiresAt = parseSharedTaskExpiresAt(expiresRaw, lang);
  const applyAllRosters = interaction.options.getBoolean("all_rosters", false) === true;

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
    { failed: !SHARED_TASK_PRESETS[request.presetKey], stem: "invalidPreset" },
    { failed: !request.taskName, stem: "customNeedsName" },
    { failed: Number.isNaN(request.expiresAt), stem: "invalidExpiry" },
    { failed: request.expiresAt && request.expiresAt < Date.now(), stem: "pastExpiry" },
  ];
  const match = checks.find((check) => check.failed);
  if (!match) return null;
  return {
    kind: NoticeKind.INPUT,
    title: t(`raid-task.sharedAdd.${match.stem}Title`, lang),
    description: t(`raid-task.sharedAdd.${match.stem}Description`, lang),
    tip: t(`raid-task.sharedAdd.${match.stem}Tip`, lang),
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
  if (!hasRosterAccounts(userDoc)) {
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
      return false;
    }
  }

  if (request.applyAllRosters && result.addedRosters.length === 0) {
    result.outcome = "none-added";
  }
  return result.addedRosters.length > 0;
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

function buildTypeField(request, lang) {
  const expirySuffix = request.expiresAt
    ? t("raid-task.sharedAdd.expirySuffix", lang, {
        date: formatDiscordTimestamp(request.expiresAt, "D"),
      })
    : "";
  return {
    name: t("raid-task.fields.type", lang),
    value: `${request.preset.emoji} ${request.preset.label}${expirySuffix}`,
    inline: true,
  };
}

function buildSkippedField(result, lang) {
  const summary = buildSkippedSummary(result, lang);
  if (!summary) return null;
  return { name: t("raid-task.fields.skipped", lang), value: summary, inline: false };
}

function buildSharedAddSuccessNotice(result, request, lang) {
  const taskName = `${request.preset.emoji} ${request.taskName}`;
  const notice = {
    kind: NoticeKind.DONE,
    title: t("raid-task.sharedAdd.successTitle", lang),
    tip: t("raid-task.sharedAdd.successTip", lang),
  };
  if (!request.applyAllRosters) {
    return {
      ...notice,
      description: t("raid-task.sharedAdd.successDescriptionSingle", lang, {
        rosterName: result.resolvedRosterName,
        taskName,
      }),
      fields: [buildTypeField(request, lang)],
    };
  }
  return {
    ...notice,
    description: t("raid-task.sharedAdd.successDescriptionMulti", lang, {
      taskName,
      addedCount: result.addedRosters.length,
    }),
    fields: [
      buildTypeField(request, lang),
      { name: t("raid-task.fields.added", lang), value: result.addedRosters.join(", "), inline: false },
      buildSkippedField(result, lang),
    ],
  };
}

function buildNoNewRosterNotice(result, request, lang) {
  return {
    kind: NoticeKind.INPUT,
    title: t("raid-task.sharedAdd.noNewRosterTitle", lang),
    description: t("raid-task.sharedAdd.noNewRosterDescription", lang, {
      count: result.targetRosterCount,
      taskName: `${request.preset.emoji} ${request.taskName}`,
    }),
    fields: [buildTypeField(request, lang), buildSkippedField(result, lang)],
    tip: t("raid-task.sharedAdd.noNewRosterTip", lang),
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
    kind: NoticeKind.INPUT,
    title: t("raid-task.sharedAdd.duplicateTitle", lang),
    description,
    tip: t("raid-task.sharedAdd.duplicateTip", lang),
  };
}

const SHARED_ADD_NOTICE_BUILDERS = {
  "no-roster": ({ request, lang }) => buildRosterNotFoundNotice(request.rosterName, lang),
  "no-roster-match": ({ request, lang }) => buildRosterNotFoundNotice(request.rosterName, lang),
  "none-added": ({ result, request, lang }) => buildNoNewRosterNotice(result, request, lang),
  "cap-reached": ({ result, request, lang }) => ({
    kind: NoticeKind.INPUT,
    title: t("raid-task.sharedAdd.capReachedTitle", lang),
    description: t("raid-task.sharedAdd.capReachedDescriptionSingle", lang, {
      rosterName: result.resolvedRosterName,
      count: result.countForReset,
      cap: sharedTaskCapForReset(request.reset),
      resetLabel: formatSharedResetDetail(request.reset, { t, lang }),
    }),
    tip: t("raid-task.sharedAdd.capReachedTip", lang),
  }),
  duplicate: ({ result, request, lang }) => buildDuplicateNotice(result, request, lang),
  added: ({ result, request, lang }) => buildSharedAddSuccessNotice(result, request, lang),
};

/**
 * Notice for one /raid-task shared-add outcome.
 * @param {{outcome: string, resolvedRosterName: string, countForReset: number, targetRosterCount: number, addedRosters: string[], skippedDup: string[], skippedCap: string[]}} result
 * @param {{applyAllRosters: boolean, expiresAt: number|null, preset: object, reset: string, rosterName: string, taskName: string}} request
 * @param {string} lang
 * @returns {object} notice options for buildNoticeEmbed
 */
function buildSharedAddNotice(result, request, lang) {
  const builder = SHARED_ADD_NOTICE_BUILDERS[result.outcome] || SHARED_ADD_NOTICE_BUILDERS.added;
  return builder({ result, request, lang });
}

function createSharedAddHandler(deps) {
  return createTaskMutationHandler(deps, {
    commandName: "shared-add",
    readRequest: readSharedAddRequest,
    buildValidationNotice: buildValidationNotice,
    createResult: createSharedAddResult,
    applyToUserDoc: applySharedAddToUserDoc,
    buildNotice: buildSharedAddNotice,
    saveFailedDescriptionKey: "raid-task.save.sharedAddFailedDescription",
  });
}

module.exports = { createSharedAddHandler };
