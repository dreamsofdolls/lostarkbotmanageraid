"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");

function buildRaidAnnounceAutocompleteOptions({
  current,
  overridable,
  lang,
}) {
  const options = [
    { name: t("raid-announce.autocomplete.show", lang), value: "show" },
  ];
  if (current) {
    options.push(
      current.enabled
        ? { name: t("raid-announce.autocomplete.turnOffWithState", lang), value: "off" }
        : { name: t("raid-announce.autocomplete.turnOnWithState", lang), value: "on" }
    );
  } else {
    options.push(
      { name: t("raid-announce.autocomplete.turnOnGeneric", lang), value: "on" },
      { name: t("raid-announce.autocomplete.turnOffGeneric", lang), value: "off" }
    );
  }

  if (overridable) {
    options.push({ name: t("raid-announce.autocomplete.setChannel", lang), value: "set-channel" });
    if (current?.channelId) {
      options.push({
        name: t("raid-announce.autocomplete.clearChannel", lang),
        value: "clear-channel",
      });
    }
  }
  return options;
}

function filterRaidAnnounceAutocompleteOptions({ options, needle, normalizeName }) {
  const normalizedNeedle = normalizeName(needle || "");
  const filtered = !normalizedNeedle
    ? options
    : options.filter(
        (choice) =>
          normalizeName(choice.name).includes(normalizedNeedle) ||
          normalizeName(choice.value).includes(normalizedNeedle)
      );
  return filtered.slice(0, 25);
}

function createRaidAnnounceAutocompleteHandler({
  User,
  GuildConfig,
  normalizeName,
  announcementTypeEntry,
  getAnnouncementsConfig,
}) {
  return async function handleRaidAnnounceAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }

      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      const typeValue = interaction.options.getString("type");
      const entry = typeValue ? announcementTypeEntry(typeValue) : null;
      let current = null;
      if (entry && interaction.guildId) {
        try {
          const cfg = await GuildConfig.findOne({ guildId: interaction.guildId })
            .select(`announcements.${entry.subdocKey} raidChannelId`)
            .lean();
          current = getAnnouncementsConfig(cfg)[entry.subdocKey];
        } catch (err) {
          console.warn("[autocomplete] raid-announce state load failed:", err?.message || err);
        }
      }

      const options = buildRaidAnnounceAutocompleteOptions({
        current,
        overridable: entry?.channelOverridable === true,
        lang,
      });
      await interaction.respond(
        filterRaidAnnounceAutocompleteOptions({
          options,
          needle: focused.value,
          normalizeName,
        })
      ).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-announce error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  };
}

module.exports = {
  createRaidAnnounceAutocompleteHandler,
  __test: {
    buildRaidAnnounceAutocompleteOptions,
    filterRaidAnnounceAutocompleteOptions,
  },
};
