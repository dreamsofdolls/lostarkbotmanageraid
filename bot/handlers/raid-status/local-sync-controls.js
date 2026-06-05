"use strict";

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function buildLocalSyncUrl(token, baseUrl = publicBaseUrl()) {
  if (!baseUrl || !token) return null;
  return `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
}

function buildLocalSyncResumeButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  url,
  disabled = false,
}) {
  if (!url) return null;
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel(t("raid-status.sync.localOpenButtonLabel", lang))
    .setEmoji("🌐")
    .setURL(url)
    .setDisabled(disabled);
}

function buildLocalSyncNewButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  url,
  disabled,
}) {
  if (!url) return null;
  return new ButtonBuilder()
    .setCustomId("status:local-new-link")
    .setLabel(t("raid-status.sync.localNewLinkButtonLabel", lang))
    .setEmoji("🆕")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function buildLocalSyncRefreshButton({
  ButtonBuilder,
  ButtonStyle,
  t,
  lang,
  disabled,
}) {
  return new ButtonBuilder()
    .setCustomId("status:local-refresh")
    .setLabel(t("raid-status.sync.localRefreshButtonLabel", lang))
    .setEmoji("🔄")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function buildBibleSyncButton({
  ButtonBuilder,
  ButtonStyle,
  label,
  disabled,
}) {
  return new ButtonBuilder()
    .setCustomId("status:sync")
    .setLabel(label)
    .setEmoji("🔄")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);
}

module.exports = {
  publicBaseUrl,
  buildLocalSyncUrl,
  buildLocalSyncResumeButton,
  buildLocalSyncNewButton,
  buildLocalSyncRefreshButton,
  buildBibleSyncButton,
};
