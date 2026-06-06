"use strict";

const { t } = require("../../../services/i18n");
const {
  getOrMintLocalSyncToken,
  extractProfileFromUser,
} = require("../../../services/local-sync");
const {
  publicBaseUrl,
  buildLocalSyncUrl,
  buildLocalSyncResumeButton: makeLocalSyncResumeButton,
  buildLocalSyncNewButton: makeLocalSyncNewButton,
  buildLocalSyncRefreshButton: makeLocalSyncRefreshButton,
  buildBibleSyncButton: makeBibleSyncButton,
} = require("../local-sync-controls");

function createRaidStatusSyncControls({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  User,
  discordId,
  lang,
  formatNextCooldownRemaining,
  getAutoManageCooldownMs,
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getStatusUserMeta,
}) {
  let cachedLocalSyncResumeUrl = null;

  const resolveCooldownMs = () =>
    typeof getAutoManageCooldownMs === "function"
      ? getAutoManageCooldownMs(discordId)
      : AUTO_MANAGE_SYNC_COOLDOWN_MS;

  const computeSyncLabel = () => {
    const remain = formatNextCooldownRemaining(
      Number(getStatusUserMeta().lastAutoManageAttemptAt) || 0,
      resolveCooldownMs(),
    );
    return remain
      ? t("raid-status.sync.buttonCooldown", lang, { remain })
      : t("raid-status.sync.buttonReady", lang);
  };

  async function hydrateLocalSyncResumeUrl(interactionUser) {
    if (!getStatusUserMeta().localSyncEnabled) return;
    const baseUrl = publicBaseUrl();
    if (!baseUrl) return;
    try {
      const profile = extractProfileFromUser(interactionUser);
      const token = await getOrMintLocalSyncToken(discordId, lang, {
        UserModel: User,
        profile,
      });
      cachedLocalSyncResumeUrl = buildLocalSyncUrl(token, baseUrl);
    } catch (err) {
      console.warn("[raid-status] local-sync token resolve failed:", err?.message || err);
    }
  }

  function setCachedLocalSyncResumeUrl(value) {
    cachedLocalSyncResumeUrl = value;
  }

  const buildLocalSyncResumeButton = (disabled = false) =>
    makeLocalSyncResumeButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      url: cachedLocalSyncResumeUrl,
      disabled,
    });

  const buildLocalSyncNewButton = (disabled) =>
    makeLocalSyncNewButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      url: cachedLocalSyncResumeUrl,
      disabled,
    });

  const buildLocalSyncRefreshButton = (disabled) =>
    makeLocalSyncRefreshButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      disabled,
    });

  const buildSyncButton = (disabled) => {
    if (getStatusUserMeta().localSyncEnabled) {
      return buildLocalSyncResumeButton(disabled);
    }
    return makeBibleSyncButton({
      ButtonBuilder,
      ButtonStyle,
      label: computeSyncLabel(),
      disabled,
    });
  };

  const buildSyncRow = (disabled) => {
    const button = buildSyncButton(disabled);
    if (!button) return null;
    const row = new ActionRowBuilder().addComponents(button);
    if (getStatusUserMeta().localSyncEnabled) {
      const newButton = buildLocalSyncNewButton(disabled);
      if (newButton) row.addComponents(newButton);
      row.addComponents(buildLocalSyncRefreshButton(disabled));
    }
    return row;
  };

  return {
    buildLocalSyncNewButton,
    buildLocalSyncRefreshButton,
    buildSyncButton,
    buildSyncRow,
    hydrateLocalSyncResumeUrl,
    setCachedLocalSyncResumeUrl,
  };
}

module.exports = {
  createRaidStatusSyncControls,
};
