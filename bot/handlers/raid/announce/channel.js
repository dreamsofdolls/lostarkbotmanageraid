"use strict";

const { t } = require("../../../services/i18n");

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
      type: "warn",
      title: t("raid-announce.setChannel.notOverridableTitle", lang),
      description: t("raid-announce.setChannel.notOverridableDescription", lang, {
        type,
        typeLabel,
        overridableList: buildOverridableTypeList(announcementOverridableTypeKeys),
      }),
    });
    return;
  }

  if (!channel) {
    await replyAnnounceNotice({
      type: "warn",
      title: t("raid-announce.setChannel.missingChannelTitle", lang),
      description: t("raid-announce.setChannel.missingChannelDescription", lang),
    });
    return;
  }

  const botMember = interaction.guild?.members?.me;
  const missing = getMissingAnnouncementChannelPermissions(channel, botMember);
  if (missing.length > 0) {
    await replyAnnounceNotice({
      type: "lock",
      title: t("raid-announce.setChannel.missingPermsTitle", lang),
      description: t("raid-announce.setChannel.missingPermsDescription", lang, {
        channelId: channel.id,
        missing: missing.join(", "),
      }),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.channelId`]: channel.id } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await replyAnnounceNotice({
    type: "success",
    title: t("raid-announce.setChannel.successTitle", lang),
    description: [
      t("raid-announce.setChannel.successLineIntro", lang),
      "",
      t("raid-announce.setChannel.successLineType", lang, { type, typeLabel }),
      t("raid-announce.setChannel.successLineChannel", lang, { channelId: channel.id }),
      t("raid-announce.setChannel.successLineImpact", lang),
      "",
      t("raid-announce.setChannel.successLineRevert", lang, { type }),
    ].join("\n"),
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
      type: "warn",
      title: t("raid-announce.clearChannel.notOverridableTitle", lang),
      description: t("raid-announce.clearChannel.notOverridableDescription", lang, { type }),
    });
    return;
  }

  if (!current.channelId) {
    await replyAnnounceNotice({
      type: "info",
      title: t("raid-announce.clearChannel.noOverrideTitle", lang),
      description: t("raid-announce.clearChannel.noOverrideDescription", lang, { type }),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.channelId`]: null } }
  );
  await replyAnnounceNotice({
    type: "success",
    title: t("raid-announce.clearChannel.successTitle", lang),
    description: [
      t("raid-announce.clearChannel.successLineIntro", lang),
      "",
      t("raid-announce.clearChannel.successLineType", lang, { type, typeLabel }),
      t("raid-announce.clearChannel.successLineChannel", lang),
      t("raid-announce.clearChannel.successLineImpact", lang),
      "",
      t("raid-announce.clearChannel.successLineRevert", lang),
    ].join("\n"),
  });
}

module.exports = {
  handleClearAnnouncementChannel,
  handleSetAnnouncementChannel,
  __test: {
    buildOverridableTypeList,
  },
};
