"use strict";

const {
  COMPANION_SCOPE,
  applyPreviewJob: applyStoredPreviewJob,
  cancelPreviewJob,
  getLatestPreviewJob,
  getOrMintLocalSyncToken,
  getPreviewJob,
  recordPreviewDelivery,
  issueLocalSyncAccessUrl,
  resolvePreviewJobState,
} = require("../../services/local-sync");
const {
  bucketizeCurrentWeekDeltas,
  projectSummary,
} = require("../../services/local-sync/http/endpoints/preview-summary-endpoint");
const { getCurrentResetStartMs } = require("../../services/raid/schedulers/weekly-reset");
const { FILTER_ALL_ROSTERS } = require("../raid-status/raid-filter");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  buildLocalSyncConsolePayload,
  buildResultDescription,
} = require("./discord-console-ui");

const RAID_STATUS_HANDOFF_STATES = new Set([
  "applied",
  "cancelled",
  "superseded",
  "expired",
]);
const LATEST_PREVIEW_FALLBACK_STATES = new Set(["superseded", "expired"]);

function activeScopeForUser(userDoc) {
  if (userDoc?.localSyncEnabled) return COMPANION_SCOPE.full;
  if (userDoc?.autoManageEnabled) return COMPANION_SCOPE.solo;
  return null;
}

function shouldOpenRaidStatusSurface(job, activeScope) {
  if (!activeScope) return false;
  if (!job) return true;
  return RAID_STATUS_HANDOFF_STATES.has(resolvePreviewJobState(job));
}

function buildRaidStatusHandoffContent(job, lang) {
  if (!job) return null;
  const state = resolvePreviewJobState(job);
  const icon = state === "applied" ? "✅" : "ℹ️";
  return `${icon} ${buildResultDescription(job, state, lang)}`;
}

async function loadConsoleUser(UserModel, discordId) {
  return UserModel.findOne({ discordId })
    .select(
      "autoManageEnabled localSyncEnabled language lastLocalSyncToken lastLocalSyncTokenExpAt " +
      "accounts.accountName accounts.characters.name accounts.characters.class " +
      "accounts.characters.itemLevel accounts.characters.isGoldEarner accounts.characters.assignedRaids"
    )
    .lean();
}

function previewSummaryForJob(userDoc, job) {
  if (!job || !userDoc) return null;
  const currentWeekStartMs = getCurrentResetStartMs();
  return projectSummary(
    userDoc.accounts || [],
    bucketizeCurrentWeekDeltas(job.deltas || [], currentWeekStartMs),
    {
      scope: job.scope,
      currentWeekStartMs,
    }
  );
}

function createLocalSyncDiscordConsole({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder = null,
  truncateText = (value) => String(value),
  MessageFlags,
  UI,
  User,
  formatGold,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  acquireAutoManageSyncSlot = null,
  releaseAutoManageSyncSlot = null,
  PreviewModel = null,
  openRaidStatusSession = null,
}) {
  if (!User) throw new Error("[local-sync/discord] User model required");

  const jobDeps = PreviewModel ? { PreviewModel } : {};

  async function resolveReaderUrl(discordUser, userDoc, lang) {
    const scope = activeScopeForUser(userDoc);
    if (!scope) return null;
    try {
      return await issueLocalSyncAccessUrl({
        discordId: discordUser.id,
        lang,
        UserModel: User,
        discordUser,
        userDoc,
        scope,
        tokenProvider: getOrMintLocalSyncToken,
      });
    } catch (err) {
      console.warn("[local-sync/discord] reader URL failed:", err?.message || err);
      return null;
    }
  }

  async function buildConsole(discordUser, { job = null, lang, userDoc = null, rosterFilter = null } = {}) {
    const loadedUser = userDoc || await loadConsoleUser(User, discordUser.id);
    const activeScope = activeScopeForUser(loadedUser);
    const readerUrl = await resolveReaderUrl(discordUser, loadedUser, lang);
    // The stored projection remains a fallback, but it can become stale if
    // progress changes before the owner reopens or refreshes the console.
    // Re-project against the freshly loaded User snapshot whenever possible.
    let summary = job?.projection || null;
    try {
      summary = previewSummaryForJob(loadedUser, job) || summary;
    } catch (err) {
      console.warn("[local-sync/discord] preview re-projection failed:", err?.message || err);
    }
    return buildLocalSyncConsolePayload({
      job,
      summary,
      readerUrl,
      activeScope,
      lang,
      rosterFilter,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      truncateText,
      UI,
      formatGold,
    });
  }

  async function maybeOpenRaidStatus(interaction, { job, lang, userDoc }) {
    const activeScope = activeScopeForUser(userDoc);
    if (
      typeof openRaidStatusSession !== "function" ||
      !shouldOpenRaidStatusSurface(job, activeScope)
    ) {
      return false;
    }

    try {
      // Do not retain a raid-status session inside the Local Sync console.
      // A durable DM preview can outlive the status collector; after one of
      // its global buttons settles the job, hand the same interaction to a
      // fresh status viewer on the Local Sync entry.
      await openRaidStatusSession(interaction, {
        alreadyDeferred: true,
        initialView: "sync",
        content: buildRaidStatusHandoffContent(job, lang),
      });
      return true;
    } catch (err) {
      console.warn("[local-sync/discord] raid-status handoff failed:", err?.message || err);
      return false;
    }
  }

  async function preferLatestActionableJob(job, discordId) {
    if (!LATEST_PREVIEW_FALLBACK_STATES.has(resolvePreviewJobState(job))) return job;
    const latestJob = await getLatestPreviewJob(discordId, jobDeps);
    if (!latestJob || latestJob.jobId === job?.jobId) return job;
    return RAID_STATUS_HANDOFF_STATES.has(resolvePreviewJobState(latestJob))
      ? job
      : latestJob;
  }

  async function loadInteractionPreviewContext(interaction, jobId) {
    const [job, userDoc] = await Promise.all([
      getPreviewJob(jobId, jobDeps),
      loadConsoleUser(User, interaction.user.id),
    ]);
    const lang = await getUserLanguage(interaction.user.id, {
      UserModel: User,
      userDoc,
    });
    return { job, userDoc, lang };
  }

  async function notifyPreviewReady(client, {
    jobId,
    discordId,
    lang = "vi",
    job: providedJob = null,
    userDoc: providedUserDoc = null,
  }) {
    if (!client?.users?.fetch) {
      return { delivered: false, error: "Discord client unavailable" };
    }
    if (providedJob && providedJob.discordId !== discordId) {
      return { delivered: false, error: "preview job unavailable" };
    }
    // Job lookup, Discord user lookup, and roster lookup are independent.
    // Run them together; the HTTP handoff can also supply the two MongoDB
    // snapshots it just created/read so the usual path only waits on Discord.
    const [job, targetUser, userDoc] = await Promise.all([
      providedJob || getPreviewJob(jobId, jobDeps),
      client.users.fetch(discordId),
      providedUserDoc || loadConsoleUser(User, discordId),
    ]);
    if (!job || job.discordId !== discordId) {
      return { delivered: false, error: "preview job unavailable" };
    }
    const payload = await buildConsole(targetUser, { job, lang, userDoc });
    const message = await targetUser.send(payload);
    await recordPreviewDelivery(jobId, discordId, message, jobDeps).catch((err) => {
      console.warn("[local-sync/discord] delivery receipt failed:", err?.message || err);
    });
    return { delivered: true, channel: "dm", messageId: message.id };
  }

  // Roster picker on the standalone console and the DM. There is no
  // session here, so the choice rides in the select's value and the job
  // in the customId · re-rendering narrowed needs nothing else.
  async function handleLocalSyncRosterSelect(interaction) {
    const [, action, jobId] = String(interaction.customId || "").split(":");
    if (action !== "roster" || !jobId) return;
    await interaction.deferUpdate();
    // "Rosters" is Local Sync's aggregate entry · it drops the filter and
    // shows every roster in the preview again. /raid-status intentionally has
    // no aggregate entry because its card always renders one paginated roster.
    const picked = String(interaction.values?.[0] ?? "");
    const rosterFilter = picked === FILTER_ALL_ROSTERS ? null : Number(picked) || 0;
    const { job, userDoc, lang } = await loadInteractionPreviewContext(
      interaction,
      jobId,
    );
    if (!job || job.discordId !== interaction.user.id) return;
    await interaction.editReply(await buildConsole(interaction.user, {
      job,
      lang,
      userDoc,
      rosterFilter,
    }));
  }

  async function handleLocalSyncButton(interaction) {
    const [, action, jobId] = String(interaction.customId || "").split(":");
    if (action === "roster") return handleLocalSyncRosterSelect(interaction);
    if (!jobId || !["apply", "cancel", "refresh"].includes(action)) return;
    // Acknowledge before any DB read so a slow Mongo round-trip cannot cross
    // Discord's interaction deadline. Ownership is still checked before any
    // mutation or message edit.
    await interaction.deferUpdate();

    const {
      job: existing,
      userDoc: initialUserDoc,
      lang,
    } = await loadInteractionPreviewContext(interaction, jobId);
    if (!existing) {
      const latestJob = await getLatestPreviewJob(interaction.user.id, jobDeps);
      if (await maybeOpenRaidStatus(interaction, {
        job: latestJob,
        lang,
        userDoc: initialUserDoc,
      })) {
        return;
      }
      await interaction.editReply(await buildConsole(interaction.user, {
        job: latestJob,
        lang,
        userDoc: initialUserDoc,
      }));
      return;
    }
    if (existing.discordId !== interaction.user.id) {
      await interaction.followUp({
        content: t("local-sync-discord.notOwner", lang),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    let nextJob;
    if (action === "apply") {
      const outcome = await applyStoredPreviewJob(jobId, interaction.user.id, {
        UserModel: User,
        PreviewModel,
        applyRaidSetForDiscordId,
        applyRaidSetBatchForDiscordId,
        acquireAutoManageSyncSlot,
        releaseAutoManageSyncSlot,
      });
      nextJob = outcome.job || await getPreviewJob(jobId, jobDeps) || existing;
    } else if (action === "cancel") {
      nextJob = await cancelPreviewJob(jobId, interaction.user.id, jobDeps)
        || await getPreviewJob(jobId, jobDeps)
        || existing;
    } else {
      nextJob = await getLatestPreviewJob(interaction.user.id, jobDeps) || existing;
    }
    // Apply mutates raid progress and needs a post-write roster read. Cancel
    // and Refresh leave the User document untouched, so reuse the snapshot
    // already loaded above. When a reload is needed, overlap it with the
    // independent latest-job check.
    let userDoc;
    [nextJob, userDoc] = await Promise.all([
      preferLatestActionableJob(nextJob, interaction.user.id),
      action === "apply"
        ? loadConsoleUser(User, interaction.user.id)
        : Promise.resolve(initialUserDoc),
    ]);
    if (await maybeOpenRaidStatus(interaction, {
      job: nextJob,
      lang,
      userDoc,
    })) {
      return;
    }
    await interaction.editReply(await buildConsole(interaction.user, {
      job: nextJob,
      lang,
      userDoc,
    }));
  }

  return {
    handleLocalSyncButton,
    handleLocalSyncRosterSelect,
    notifyPreviewReady,
    buildConsole,
  };
}

module.exports = {
  activeScopeForUser,
  shouldOpenRaidStatusSurface,
  previewSummaryForJob,
  createLocalSyncDiscordConsole,
};
