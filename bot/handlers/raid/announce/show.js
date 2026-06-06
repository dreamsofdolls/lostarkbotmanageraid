"use strict";

const { t } = require("../../../services/i18n");

const PREVIEW_BUILDERS = Object.freeze({
  "hourly-cleanup": ({ buildCleanupNoticePreview }) => buildCleanupNoticePreview(),
  "maintenance-early": ({ buildMaintenancePreview }) => buildMaintenancePreview("early"),
  "maintenance-countdown": ({ buildMaintenancePreview }) => buildMaintenancePreview("countdown"),
});

function buildAnnouncementPreviewText({
  type,
  entry,
  lang,
  truncateText,
  buildCleanupNoticePreview,
  buildMaintenancePreview,
}) {
  const buildPreview = PREVIEW_BUILDERS[type];
  if (buildPreview) {
    return truncateText(
      buildPreview({ buildCleanupNoticePreview, buildMaintenancePreview }),
      1024
    );
  }
  return entry.previewContent
    ? truncateText(entry.previewContent, 1024)
    : t("raid-announce.show.previewMissing", lang);
}

function buildDestinationText({ current, existing, overridable, lang }) {
  const resolvedChannelId = current.channelId || existing?.raidChannelId || null;
  return resolvedChannelId
    ? `<#${resolvedChannelId}>`
    : overridable
      ? t("raid-announce.show.destinationOverridable", lang)
      : t("raid-announce.show.destinationChannelBound", lang);
}

function buildChannelConfigText({ current, overridable, lang }) {
  if (current.channelId) {
    return t("raid-announce.show.channelConfigOverride", lang, {
      channelId: current.channelId,
    });
  }
  return overridable
    ? t("raid-announce.show.channelConfigNoOverride", lang)
    : t("raid-announce.show.channelConfigBound", lang);
}

function buildEnabledValue({ current, UI, lang }) {
  return current.enabled
    ? `${UI.icons.done} ${t("raid-announce.show.enabledOn", lang)}`
    : `${UI.icons.reset} ${t("raid-announce.show.enabledOff", lang)}`;
}

function buildShowAnnouncementEmbed(ctx) {
  const {
    EmbedBuilder,
    UI,
    buildAnnouncementWhenItFiresText,
    buildCleanupNoticePreview,
    buildMaintenancePreview,
    current,
    currentEntry,
    existing,
    lang,
    truncateText,
  } = ctx;
  const {
    entry,
    overridable,
    type,
    typeLabel,
  } = currentEntry;
  const scheduleText = truncateText(
    buildAnnouncementWhenItFiresText(type, entry, current, existing),
    1024
  );
  return new EmbedBuilder()
    .setColor(UI.colors.neutral)
    .setTitle(`${UI.icons.info} ${t("raid-announce.show.title", lang, { typeLabel })}`)
    .addFields(
      {
        name: t("raid-announce.show.enabledLabel", lang),
        value: buildEnabledValue({ current, UI, lang }),
        inline: true,
      },
      {
        name: t("raid-announce.show.destinationLabel", lang),
        value: buildDestinationText({ current, existing, overridable, lang }),
        inline: true,
      },
      {
        name: t("raid-announce.show.channelConfigLabel", lang),
        value: buildChannelConfigText({ current, overridable, lang }),
        inline: false,
      },
      {
        name: t("raid-announce.show.whenLabel", lang),
        value: scheduleText,
        inline: false,
      },
      {
        name: t("raid-announce.show.previewLabel", lang),
        value: buildAnnouncementPreviewText({
          type,
          entry,
          lang,
          truncateText,
          buildCleanupNoticePreview,
          buildMaintenancePreview,
        }),
        inline: false,
      }
    )
    .setTimestamp();
}

async function handleShowAnnouncement(ctx) {
  await ctx.replyAnnounceEmbed(buildShowAnnouncementEmbed(ctx));
}

module.exports = {
  handleShowAnnouncement,
  __test: {
    buildAnnouncementPreviewText,
    buildChannelConfigText,
    buildDestinationText,
    buildEnabledValue,
    buildShowAnnouncementEmbed,
  },
};
