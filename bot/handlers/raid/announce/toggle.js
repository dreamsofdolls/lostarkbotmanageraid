"use strict";

const { t } = require("../../../services/i18n");
const { NoticeKind } = require("../../../utils/raid/common/shared");

function buildToggleStateText({ enabled, lang }) {
  return enabled
    ? t("raid-announce.show.enabledOn", lang)
    : t("raid-announce.show.enabledOff", lang);
}

async function handleToggleAnnouncement(ctx) {
  const {
    GuildConfig,
    action,
    current,
    currentEntry,
    guildId,
    lang,
    replyAnnounceNotice,
  } = ctx;
  const { subdocKey, type, typeLabel } = currentEntry;
  const enabled = action === "on";
  const stateText = buildToggleStateText({ enabled, lang });

  if (current.enabled === enabled) {
    await replyAnnounceNotice({
      kind: NoticeKind.INPUT,
      title: t("raid-announce.toggle.noopTitle", lang),
      description: t("raid-announce.toggle.noopDescription", lang, {
        type,
        state: stateText,
      }),
      tip: t("raid-announce.toggle.checkTip", lang),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.enabled`]: enabled } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await replyAnnounceNotice({
    kind: NoticeKind.DONE,
    title: t("raid-announce.toggle.successTitle", lang),
    description: t(
      enabled
        ? "raid-announce.toggle.successDescriptionOn"
        : "raid-announce.toggle.successDescriptionOff",
      lang,
      { type, typeLabel, state: stateText }
    ),
    tip: t("raid-announce.toggle.checkTip", lang),
  });
}

module.exports = {
  handleToggleAnnouncement,
};
