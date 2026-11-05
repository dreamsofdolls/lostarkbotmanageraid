"use strict";

const { t } = require("../../../services/i18n");
const { NoticeKind } = require("../../../utils/raid/common/shared");

function buildOverridableTypeList(announcementOverridableTypeKeys) {
  return announcementOverridableTypeKeys()
    .map((key) => `\`${key}\``)
    .join(", ");
}

async function handleSetAnnouncementChannel(ctx) {
  const {
    GuildConfig,
    announcementOverridableTypeKeys,
    channel,
    currentEntry,
    getMissingAnnouncementChannelPermissions,
    guildId,
    interaction,
    lang,
    replyAnnounceNotice,
  } = ctx;
  const {
    subdocKey,
    type,
    typeLabel,
    overridable,
  } = currentEntry;

  if (!overridable) {
    await replyAnnounceNotice({
      kind: NoticeKind.INPUT,
      title: t("raid-announce.setChannel.notOverridableTitle", lang),
      description: t("raid-announce.setChannel.notOverridableDescription", lang, {
        type,
        typeLabel,
        overridableList: buildOverridableTypeList(announcementOverridableTypeKeys),
      }),
      tip: t("raid-announce.setChannel.notOverridableTip", lang),
    });
    return;
  }

  if (!channel) {
    await replyAnnounceNotice({
      kind: NoticeKind.INPUT,
      title: t("raid-announce.setChannel.missingChannelTitle", lang),
      description: t("raid-announce.setChannel.missingChannelDescription", lang),
      tip: t("raid-announce.setChannel.missingChannelTip", lang),
    });
    return;
  }

  const botMember = interaction.guild?.members?.me;
  const missing = getMissingAnnouncementChannelPermissions(channel, botMember);
  if (missing.length > 0) {
    await replyAnnounceNotice({
      kind: NoticeKind.GUARD,
      title: t("raid-announce.setChannel.missingPermsTitle", lang),
      description: t("raid-announce.setChannel.missingPermsDescription", lang, {
        channelId: channel.id,
        missing: missing.join(", "),
      }),
      tip: t("raid-announce.setChannel.missingPermsTip", lang),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.channelId`]: channel.id } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await replyAnnounceNotice({
    kind: NoticeKind.DONE,
    title: t("raid-announce.setChannel.successTitle", lang),
    description: t("raid-announce.setChannel.successDescription", lang, {
      type,
      typeLabel,
      channelId: channel.id,
    }),
    tip: t("raid-announce.setChannel.successTip", lang, { type }),
  });
}

async function handleClearAnnouncementChannel(ctx) {
  const {
    GuildConfig,
    current,
    currentEntry,
    guildId,
    lang,
    replyAnnounceNotice,
  } = ctx;
  const {
    subdocKey,
    type,
    typeLabel,
    overridable,
  } = currentEntry;

  if (!overridable) {
    await replyAnnounceNotice({
      kind: NoticeKind.INPUT,
      title: t("raid-announce.clearChannel.notOverridableTitle", lang),
      description: t("raid-announce.clearChannel.notOverridableDescription", lang, { type }),
      tip: t("raid-announce.clearChannel.notOverridableTip", lang),
    });
    return;
  }

  if (!current.channelId) {
    await replyAnnounceNotice({
      kind: NoticeKind.INPUT,
      title: t("raid-announce.clearChannel.noOverrideTitle", lang),
      description: t("raid-announce.clearChannel.noOverrideDescription", lang, { type }),
      tip: t("raid-announce.clearChannel.noOverrideTip", lang),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.channelId`]: null } }
  );
  await replyAnnounceNotice({
    kind: NoticeKind.DONE,
    title: t("raid-announce.clearChannel.successTitle", lang),
    description: t("raid-announce.clearChannel.successDescription", lang, { type, typeLabel }),
    tip: t("raid-announce.clearChannel.successTip", lang),
  });
}

module.exports = {
  handleClearAnnouncementChannel,
  handleSetAnnouncementChannel,
};
