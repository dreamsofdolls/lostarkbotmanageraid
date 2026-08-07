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
const { buildLocalSyncConsolePayload } = require("./discord-console-ui");

function activeScopeForUser(userDoc) {
  if (userDoc?.localSyncEnabled) return COMPANION_SCOPE.full;
  if (userDoc?.autoManageEnabled) return COMPANION_SCOPE.solo;
  return null;
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
  MessageFlags,
  UI,
  User,
  formatGold,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  acquireAutoManageSyncSlot = null,
  releaseAutoManageSyncSlot = null,
  PreviewModel = null,
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

  async function buildConsole(discordUser, { job = null, lang, userDoc = null } = {}) {
    const loadedUser = userDoc || await loadConsoleUser(User, discordUser.id);
    const activeScope = activeScopeForUser(loadedUser);
    const readerUrl = await resolveReaderUrl(discordUser, loadedUser, lang);
    const summary = job?.projection || previewSummaryForJob(loadedUser, job);
    return buildLocalSyncConsolePayload({
      job,
      summary,
      readerUrl,
      activeScope,
      lang,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      UI,
      formatGold,
    });
  }

  async function handleRaidSyncCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const discordId = interaction.user.id;
    const [lang, userDoc, latestJob] = await Promise.all([
      getUserLanguage(discordId, { UserModel: User }),
      loadConsoleUser(User, discordId),
      getLatestPreviewJob(discordId, jobDeps),
    ]);
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

  async function renderMissingJob(interaction, lang) {
    const payload = {
      content: t("local-sync-discord.jobMissing", lang),
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }

  async function handleLocalSyncButton(interaction) {
    const [, action, jobId] = String(interaction.customId || "").split(":");
    if (!jobId || !["apply", "cancel", "refresh"].includes(action)) return;

    const [lang, existing] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      getPreviewJob(jobId, jobDeps),
    ]);
    if (!existing) {
      await renderMissingJob(interaction, lang);
      return;
    }
    if (existing.discordId !== interaction.user.id) {
      await interaction.reply({
        content: t("local-sync-discord.notOwner", lang),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await interaction.deferUpdate();
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
      nextJob = await getPreviewJob(jobId, jobDeps) || existing;
    }

    const userDoc = await loadConsoleUser(User, interaction.user.id);
    await interaction.editReply(await buildConsole(interaction.user, {
      job: nextJob,
      lang,
      userDoc,
    }));
  }

  return {
    handleRaidSyncCommand,
    handleLocalSyncButton,
    notifyPreviewReady,
    buildConsole,
  };
}

module.exports = {
  activeScopeForUser,
  previewSummaryForJob,
  createLocalSyncDiscordConsole,
};
