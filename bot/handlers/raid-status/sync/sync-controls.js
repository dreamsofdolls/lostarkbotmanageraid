"use strict";

const { t } = require("../../../services/i18n");
const {
  getOrMintLocalSyncToken,
  extractIdentityFromUser,
} = require("../../../services/local-sync");
const {
  publicBaseUrl,
  buildLocalSyncUrl,
  buildLocalSyncResumeButton: makeLocalSyncResumeButton,
  buildLocalSyncNewButton: makeLocalSyncNewButton,
  buildLocalSyncRefreshButton: makeLocalSyncRefreshButton,
  buildRosterRefreshButton: makeRosterRefreshButton,
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
      const identity = extractIdentityFromUser(interactionUser);
      const token = await getOrMintLocalSyncToken(discordId, lang, {
        UserModel: User,
        identity,
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

  const buildRosterRefreshButton = (disabled) =>
    makeRosterRefreshButton({
      ButtonBuilder,
      ButtonStyle,
      t,
      lang,
      disabled,
    });

  const buildSoloCompanionButton = (disabled = false) => {
    const statusUserMeta = getStatusUserMeta();
    if (!statusUserMeta.autoManageEnabled || statusUserMeta.localSyncEnabled) {
      return null;
    }
    return new ButtonBuilder()
      .setCustomId("status:solo-companion")
      .setLabel(t("raid-status.sync.soloCompanionButtonLabel", lang))
      .setEmoji("\u{1f310}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  };

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
    buildRosterRefreshButton,
    buildSoloCompanionButton,
    buildSyncButton,
    buildSyncRow,
    hydrateLocalSyncResumeUrl,
    setCachedLocalSyncResumeUrl,
  };
}

module.exports = {
  createRaidStatusSyncControls,
};
