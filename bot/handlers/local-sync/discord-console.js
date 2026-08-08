"use strict";

const {
  COMPANION_SCOPE,
  applyPreviewJob: applyStoredPreviewJob,
  cancelPreviewJob,
  getLatestPreviewJob,
  getOrMintLocalSyncToken,
  getPreviewJob,
  recordPreviewDelivery,
  extractIdentityFromUser,
  resolvePreviewJobState,
} = require("../../services/local-sync");
const {
  bucketizeCurrentWeekDeltas,
  projectSummary,
} = require("../../services/local-sync/http/endpoints/preview-summary-endpoint");
const { getCurrentResetStartMs } = require("../../services/raid/schedulers/weekly-reset");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  publicBaseUrl,
  buildLocalSyncUrl,
} = require("../raid-status/local-sync-controls");
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
    const baseUrl = publicBaseUrl();
    if (!scope || !baseUrl) return null;
    try {
      const token = await getOrMintLocalSyncToken(discordUser.id, lang, {
        UserModel: User,
        identity: extractIdentityFromUser(discordUser),
        scope,
      });
      return buildLocalSyncUrl(token, baseUrl);
    } catch (err) {
      console.warn("[local-sync/discord] reader URL failed:", err?.message || err);
      return null;
    }
  }

  async function buildConsole(discordUser, { job = null, lang, userDoc = null, rosterIndex = 0 } = {}) {
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
      rosterIndex,
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
      // Calling the canonical handler here creates a new viewer loader, so
      // every /raid-sync invocation reads the current DB snapshot again.
      // initialView lands on the status dropdown's Local Sync entry, so a
      // settled preview keeps its own frame instead of dropping the user
      // on the raid page with only a one-line result banner.
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

  async function handleRaidSyncCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const discordId = interaction.user.id;
    const [userDoc, latestJob] = await Promise.all([
      loadConsoleUser(User, discordId),
      getLatestPreviewJob(discordId, jobDeps),
    ]);
    const lang = await getUserLanguage(discordId, {
      UserModel: User,
      userDoc,
    });
    if (await maybeOpenRaidStatus(interaction, {
      job: latestJob,
      lang,
      userDoc,
    })) {
      return;
    }
    await interaction.editReply(await buildConsole(interaction.user, {
      job: latestJob,
      lang,
      userDoc,
    }));
  }

  async function notifyPreviewReady(client, { jobId, discordId, lang = "vi" }) {
    if (!client?.users?.fetch) {
      return { delivered: false, error: "Discord client unavailable" };
    }
    const job = await getPreviewJob(jobId, jobDeps);
    if (!job || job.discordId !== discordId) {
      return { delivered: false, error: "preview job unavailable" };
    }
    const targetUser = await client.users.fetch(discordId);
    const userDoc = await loadConsoleUser(User, discordId);
    const payload = await buildConsole(targetUser, { job, lang, userDoc });
    const message = await targetUser.send(payload);
    await recordPreviewDelivery(jobId, discordId, message, jobDeps).catch((err) => {
      console.warn("[local-sync/discord] delivery receipt failed:", err?.message || err);
    });
    return { delivered: true, channel: "dm", messageId: message.id };
  }

  // Roster picker on the standalone console and the DM. There is no
  // session here, so the page rides in the select's value and the job in
  // the customId · re-rendering with a different page needs nothing else.
  async function handleLocalSyncRosterSelect(interaction) {
    const [, action, jobId] = String(interaction.customId || "").split(":");
    if (action !== "roster" || !jobId) return;
    await interaction.deferUpdate();
    const rosterIndex = Number(interaction.values?.[0] ?? 0) || 0;
    const [lang, job, userDoc] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      getPreviewJob(jobId, jobDeps),
      loadConsoleUser(User, interaction.user.id),
    ]);
    if (!job || job.discordId !== interaction.user.id) return;
    await interaction.editReply(await buildConsole(interaction.user, {
      job,
      lang,
      userDoc,
      rosterIndex,
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

    const [lang, existing] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      getPreviewJob(jobId, jobDeps),
    ]);
    if (!existing) {
      const [userDoc, latestJob] = await Promise.all([
        loadConsoleUser(User, interaction.user.id),
        getLatestPreviewJob(interaction.user.id, jobDeps),
      ]);
      if (await maybeOpenRaidStatus(interaction, {
        job: latestJob,
        lang,
        userDoc,
      })) {
        return;
      }
      await interaction.editReply(await buildConsole(interaction.user, {
        job: latestJob,
        lang,
        userDoc,
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

    let nextJob = existing;
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
    nextJob = await preferLatestActionableJob(nextJob, interaction.user.id);

    const userDoc = await loadConsoleUser(User, interaction.user.id);
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
    handleRaidSyncCommand,
    handleLocalSyncButton,
    handleLocalSyncRosterSelect,
    notifyPreviewReady,
    buildConsole,
  };
}

module.exports = {
  activeScopeForUser,
  shouldOpenRaidStatusSurface,
  buildRaidStatusHandoffContent,
  previewSummaryForJob,
  createLocalSyncDiscordConsole,
};
