"use strict";

const { t } = require("../../../services/i18n");
const { createAutocompleteDispatcher } = require("../../../utils/raid/common/autocomplete");
const {
  filterAutocompleteChoices,
} = require("../../../utils/discord/select-options");

function buildRaidAnnounceAutocompleteOptions({
  current,
  overridable,
  lang,
  includeAllActions = false,
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
    if (includeAllActions || current?.channelId) {
      options.push({
        name: t("raid-announce.autocomplete.clearChannel", lang),
        value: "clear-channel",
      });
    }
  }
  return options;
}

function resolveAutocompleteLanguage(interaction) {
  const locale = String(interaction?.locale || interaction?.guildLocale || "").toLowerCase();
  if (locale.startsWith("ja")) return "jp";
  if (locale.startsWith("en")) return "en";
  return "vi";
}

function filterRaidAnnounceAutocompleteOptions({ options, needle, normalizeName }) {
  return filterAutocompleteChoices(options, {
    needle,
    normalize: normalizeName,
  });
}

function createRaidAnnounceAutocompleteHandler({
  normalizeName,
  announcementTypeEntry,
}) {
  return createAutocompleteDispatcher("raid-announce", {
    async action(interaction, focused) {
      // New command schemas use static action choices. This path remains as a
      // transition fallback for Discord clients still holding the old
      // autocomplete schema, so it must answer without any DB dependency.
      const lang = resolveAutocompleteLanguage(interaction);
      const typeValue = interaction.options.getString("type");
      const entry = typeValue ? announcementTypeEntry(typeValue) : null;

      const options = buildRaidAnnounceAutocompleteOptions({
        current: null,
        overridable: entry?.channelOverridable === true,
        lang,
        includeAllActions: true,
      });
      await interaction.respond(
        filterRaidAnnounceAutocompleteOptions({
          options,
          needle: focused.value,
          normalizeName,
        })
      ).catch(() => {});
    },
  });
}

module.exports = {
  createRaidAnnounceAutocompleteHandler,
};
