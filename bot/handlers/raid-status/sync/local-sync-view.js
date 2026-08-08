/**
 * handlers/raid-status/sync/local-sync-view.js
 * Local Sync as a /raid-status view rather than a separate /raid-sync
 * message. Two invariants shape this file:
 *   1. The snapshot is loaded asynchronously up front (see
 *      loadLocalSyncSnapshot) because both raid-status render paths -
 *      buildCurrentEmbed and buildComponents - are synchronous.
 *   2. Buttons carry the STATUS_BUTTON_PREFIX namespace so the global
 *      interaction router never claims them; the raid-status collector
 *      owns every click inside its own message.
 * The DM preview surface keeps using local-sync/discord-console.js.
 */

"use strict";

const {
  applyPreviewJob,
  cancelPreviewJob,
  getLatestPreviewJob,
  getOrMintLocalSyncToken,
  getPreviewJob,
  extractIdentityFromUser,
} = require("../../../services/local-sync");
const {
  activeScopeForUser,
  previewSummaryForJob,
} = require("../../local-sync/discord-console");
const {
  STATUS_BUTTON_PREFIX,
  buildLocalSyncConsolePayload,
} = require("../../local-sync/discord-console-ui");
const { publicBaseUrl, buildLocalSyncUrl } = require("../local-sync-controls");

const LOCAL_SYNC_ACTIONS = Object.freeze([
  "apply", "cancel", "refresh", "roster", "roster-prev", "roster-next",
]);

/**
 * Split a `status-local:<action>:<jobId>` customId.
 * @param {string} customId
 * @returns {{action: string, jobId: string}|null} null when the id is not a local-sync action
 */
function parseLocalSyncViewCustomId(customId) {
  const id = String(customId || "");
  if (!id.startsWith(STATUS_BUTTON_PREFIX)) return null;
  // roster-prev / roster-next append the page they were rendered at, so
  // the stateless surfaces can step from it without a session.
  const [action, jobId, page] = id.slice(STATUS_BUTTON_PREFIX.length).split(":");
  if (!LOCAL_SYNC_ACTIONS.includes(action) || !jobId) return null;
  return { action, jobId, page: Number(page) || 0 };
}

/**
 * Whether the viewer has any sync mode on. Drives both the dropdown
 * option and the /raid-sync handoff · a viewer with no scope has
 * nothing to preview, so the option stays hidden entirely.
 * @param {object|null} userDoc - lean User document
 * @returns {boolean}
 */
function hasLocalSyncScope(userDoc) {
  return Boolean(activeScopeForUser(userDoc));
}

/**
 * Read the viewer's newest preview job plus a fresh reader URL.
 * Called from async component handlers; the result is stashed on
 * session state for the synchronous builders to read.
 * @param {object} options
 * @param {object} options.discordUser - discord.js User (id + username for token identity)
 * @param {object|null} options.userDoc - lean User document already loaded by the session
 * @param {object} options.User - Mongoose User model
 * @param {object|null} [options.PreviewModel] - injected preview model for tests
 * @param {string} options.lang
 * @param {string} [options.jobId] - load this job instead of the latest one
 * @returns {Promise<{job: object|null, summary: object|null, readerUrl: string|null, activeScope: string|null}>}
 */
async function loadLocalSyncSnapshot({
  discordUser,
  userDoc,
  User,
  PreviewModel = null,
  lang,
  jobId = "",
}) {
  const jobDeps = PreviewModel ? { PreviewModel } : {};
  const activeScope = activeScopeForUser(userDoc);
  if (!activeScope) {
    return { job: null, summary: null, readerUrl: null, activeScope: null };
  }

  const job = jobId
    ? await getPreviewJob(jobId, jobDeps).catch(() => null)
    : await getLatestPreviewJob(discordUser.id, jobDeps).catch(() => null);

  let summary = job?.projection || null;
  try {
    // Re-project against the session's User snapshot · the stored
    // projection goes stale as soon as progress moves elsewhere.
    summary = previewSummaryForJob(userDoc, job) || summary;
  } catch (err) {
    console.warn("[raid-status local-sync] re-projection failed:", err?.message || err);
  }

  let readerUrl = null;
  const baseUrl = publicBaseUrl();
  if (baseUrl) {
    try {
      const token = await getOrMintLocalSyncToken(discordUser.id, lang, {
        UserModel: User,
        identity: extractIdentityFromUser(discordUser),
        scope: activeScope,
      });
      readerUrl = buildLocalSyncUrl(token, baseUrl);
    } catch (err) {
      console.warn("[raid-status local-sync] reader URL failed:", err?.message || err);
    }
  }

  return { job, summary, readerUrl, activeScope };
}

/**
 * Build the sync view embed from a snapshot.
 * @param {object} options
 * @param {object|null} options.snapshot - result of loadLocalSyncSnapshot
 * @returns {object|null} EmbedBuilder instance, or null when there is no snapshot yet
 */
function buildLocalSyncViewEmbed({
  snapshot,
  lang,
  rosterIndex = 0,
  StringSelectMenuBuilder = null,
  truncateText,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  formatGold,
}) {
  if (!snapshot) return null;
  const payload = buildLocalSyncConsolePayload({
    ...snapshot,
    lang,
    buttonPrefix: STATUS_BUTTON_PREFIX,
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
  return payload.embeds[0] || null;
}

/**
 * Build the sync view action rows from a snapshot.
 * @param {object} options
 * @param {object|null} options.snapshot - result of loadLocalSyncSnapshot
 * @param {boolean} [options.disabled] - grey out every non-link button (expired session)
 * @returns {object[]} ActionRowBuilder rows, empty when there is no snapshot
 */
function buildLocalSyncViewRows({
  snapshot,
  lang,
  rosterIndex = 0,
  StringSelectMenuBuilder = null,
  truncateText,
  disabled = false,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  formatGold,
}) {
  if (!snapshot) return [];
  const payload = buildLocalSyncConsolePayload({
    ...snapshot,
    lang,
    buttonPrefix: STATUS_BUTTON_PREFIX,
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
  if (!disabled) return payload.components;
  // Link buttons cannot be disabled without dropping the URL, and a dead
  // session still lets the reader page open, so only customId buttons flip.
  for (const row of payload.components) {
    for (const component of row.components || []) {
      if (component?.data?.custom_id) component.setDisabled(true);
    }
  }
  return payload.components;
}

/**
 * Run one apply/cancel/refresh action against a preview job.
 * Ownership is enforced here because the collector only proves the
 * clicker owns the /raid-status session, not the job.
 * @param {object} options
 * @param {string} options.action - "apply" | "cancel" | "refresh"
 * @param {string} options.jobId
 * @param {string} options.discordId - clicker
 * @returns {Promise<{ok: boolean, reason?: string, job: object|null, applied: boolean}>}
 */
async function runLocalSyncViewAction({
  action,
  jobId,
  discordId,
  User,
  PreviewModel = null,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  acquireAutoManageSyncSlot = null,
  releaseAutoManageSyncSlot = null,
}) {
  const jobDeps = PreviewModel ? { PreviewModel } : {};
  const existing = await getPreviewJob(jobId, jobDeps).catch(() => null);
  if (!existing) return { ok: false, reason: "missing", job: null, applied: false };
  if (existing.discordId !== discordId) {
    return { ok: false, reason: "notOwner", job: null, applied: false };
  }

  if (action === "apply") {
    const outcome = await applyPreviewJob(jobId, discordId, {
      UserModel: User,
      PreviewModel,
      applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId,
      acquireAutoManageSyncSlot,
      releaseAutoManageSyncSlot,
    });
    const job = outcome?.job || await getPreviewJob(jobId, jobDeps).catch(() => null) || existing;
    return { ok: true, job, applied: true };
  }

  if (action === "cancel") {
    const job = await cancelPreviewJob(jobId, discordId, jobDeps).catch(() => null)
      || await getPreviewJob(jobId, jobDeps).catch(() => null)
      || existing;
    return { ok: true, job, applied: false };
  }

  const job = await getLatestPreviewJob(discordId, jobDeps).catch(() => null) || existing;
  return { ok: true, job, applied: false };
}

module.exports = {
  LOCAL_SYNC_ACTIONS,
  STATUS_BUTTON_PREFIX,
  buildLocalSyncViewEmbed,
  buildLocalSyncViewRows,
  hasLocalSyncScope,
  loadLocalSyncSnapshot,
  parseLocalSyncViewCustomId,
  runLocalSyncViewAction,
};
