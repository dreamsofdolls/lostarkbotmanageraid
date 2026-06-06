"use strict";

const { t } = require("../../../services/i18n");

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
      type: "info",
      title: t("raid-announce.toggle.noopTitle", lang),
      description: t("raid-announce.toggle.noopDescription", lang, {
        type,
        state: stateText,
      }),
    });
    return;
  }

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`announcements.${subdocKey}.enabled`]: enabled } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await replyAnnounceNotice({
    type: "success",
    title: t("raid-announce.toggle.successTitle", lang),
    description: [
      t("raid-announce.toggle.successLineType", lang, { type, typeLabel }),
      t("raid-announce.toggle.successLineState", lang, { state: stateText }),
      t(
        enabled
          ? "raid-announce.toggle.successLineImpactOn"
          : "raid-announce.toggle.successLineImpactOff",
        lang
      ),
      "",
      t("raid-announce.toggle.successLineCheck", lang),
    ].join("\n"),
  });
}

module.exports = {
  handleToggleAnnouncement,
  __test: {
    buildToggleStateText,
  },
};
