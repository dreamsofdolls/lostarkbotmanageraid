"use strict";

const { t } = require("../../../services/i18n");
const {
  getOrMintLocalSyncToken,
  issueLocalSyncAccessUrl,
} = require("../../../services/local-sync");
const {
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
  getStatusUserMeta,
  isReplyPrivate,
}) {
  let cachedLocalSyncResumeUrl = null;

  const resolveCooldownMs = () => getAutoManageCooldownMs(discordId);

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
    // Discord link buttons are clickable by anyone who can see the message,
    // so a public reply must never hold the signed URL. localSyncEnabled
    // can flip mid-session after the privacy probe fixed the reply type.
    if (!isReplyPrivate()) return;
    try {
      cachedLocalSyncResumeUrl = await issueLocalSyncAccessUrl({
        discordId,
        lang,
        UserModel: User,
        discordUser: interactionUser,
        tokenProvider: getOrMintLocalSyncToken,
      });
    } catch (err) {
      console.warn("[raid-status] local-sync token resolve failed:", err?.message || err);
    }
  }

  function setCachedLocalSyncResumeUrl(value) {
    // Same guard as hydrate: rotation on a public reply delivers the URL
    // via the ephemeral follow-up, never through the message itself.
    if (!isReplyPrivate()) return;
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
    const localSync = getStatusUserMeta().localSyncEnabled === true;
    // On a public reply the resume link is null (no cached URL), but the
    // new-link and refresh controls still render around it.
    const button = buildSyncButton(disabled);
    if (!button && !localSync) return null;
    const row = new ActionRowBuilder();
    if (button) row.addComponents(button);
    if (localSync) {
      row.addComponents(buildLocalSyncNewButton(disabled));
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
